// Komisyon / sure / erisim motoru testleri - gercek PostgreSQL (PGlite) uzerinde.
// Calistir: npm test
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
for (const f of ['tests/supabase-stub.sql', 'supabase/migrations/0001_schema.sql',
                 'supabase/migrations/0002_engine.sql', 'supabase/migrations/0003_rls.sql',
                 'supabase/migrations/0004_security.sql', 'supabase/migrations/0005_ranks_requests_earnings.sql',
                 'supabase/migrations/0006_jobs_sales.sql', 'supabase/migrations/0007_manual_payment_guard.sql', 'supabase/migrations/0008_drop_remote_pay_consent.sql']) {
  await db.exec(fs.readFileSync(path.join(root, f), 'utf8'));
}
// 1-13 arasi senaryolar %40 uzerine yazildi: Bronze'u gecici olarak %40 yap (bolum 14'te %50'ye doner)
await db.exec(`update ranks set commission_rate = 0.40 where code = 'BRONZE'`);

let ok = 0, bad = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'OK ' : 'XX '} ${name}${extra ? '  ' + extra : ''}`);
  cond ? ok++ : bad++;
};
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const M = 1_000_000;
const T0 = new Date('2026-11-21T09:00:00Z');                 // 12:00 Istanbul
const at = (sec) => new Date(T0.getTime() + sec * 1000).toISOString();

// ------------------------------------------------------------------ kurulum
const OP = randomUUID(), U1 = randomUUID(), U2 = randomUUID();
await q(`insert into auth.users (id, email) values ($1,'op@x'),($2,'u1@x'),($3,'u2@x')`, [OP, U1, U2]);
await q(`update profiles set role='OPERATOR' where id=$1`, [OP]);
await q(`select admin_set_setting($1,'commission_receiver','"OpBank"')`, [OP]);
await q(`select admin_add_operator_account($1,'OpBank',null,'komisyon kasasi')`, [OP]);
await q(`select admin_add_operator_account($1,'OpMain',null,'operator botu')`, [OP]);
const acc = await one(`select * from member_add_account($1,'Friend1')`, [U1]);
await one(`select * from member_add_account($1,'Other2')`, [U2]);

console.log('\n[1] Uye hesabi ve onay');
check('yeni hesap operator onayi bekler (erisim kapali)', acc.access_enabled === false);
let tok = 'tok-' + randomUUID();
let r = (await one(`select mod_session_start('Friend1',null,'XXXX',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tok, at(0)])).r;
check('onaysiz hesap bot acamaz', r.ok === false && r.reason.startsWith('ACCESS_DISABLED'), r.reason);
await q(`select admin_set_account_access($1,$2,true,null)`, [OP, acc.id]);
r = (await one(`select mod_session_start('Friend1',null,'XXXX',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tok, at(0)])).r;
check('kullanici onayi (consent) yoksa acilmaz', r.reason === 'CONSENT_REQUIRED');
await q(`select member_consent($1)`, [U1]);

console.log('\n[2] Gunluk erisim kodu');
const c1 = await one(`select * from get_or_create_daily_code($1,'AB12CD',$2)`, [acc.id, at(0)]);
const c1b = await one(`select * from get_or_create_daily_code($1,'ZZZZZZ',$2)`, [acc.id, at(3600)]);
const c2 = await one(`select * from get_or_create_daily_code($1,'QW34ER',$2)`, [acc.id, at(86400)]);
check('ayni gun ayni kod doner', c1.id === c1b.id && c1b.code === 'AB12CD');
check('ertesi gun yeni kod / yeni numara', c2.id !== c1.id && c2.code === 'QW34ER', `kod no ${c1.id} -> ${c2.id}`);
r = (await one(`select mod_session_start('Friend1',null,'QW34ER',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tok, at(0)])).r;
check('dunun/yarinin kodu bugun gecmez', r.reason === 'INVALID_CODE');
r = (await one(`select mod_session_start('Friend1',null,'ab12cd',$1,'sec','0.6.0','1.1.1.1',$2) r`, [tok, at(0)])).r;
check('eski mod surumu reddedilir', r.reason === 'MOD_OUTDATED');
r = (await one(`select mod_session_start('Friend1',null,'ab12cd',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tok, at(0)])).r;
check('dogru kod (buyuk/kucuk harf fark etmez) -> oturum acilir', r.ok === true && r.mode === 'FULL');
const sess = await one(`select * from bot_sessions where token_hash=$1`, [tok]);
check('oturumda kullanilan kod numarasi kayitli', Number(sess.daily_code_id) === Number(c1.id), `kod no ${c1.id}`);

// heartbeat yardimcisi: her 30 sn, toplam kari 'profitAt(t)' egrisine goturur
let seq = 0, lastProfit = 0, t = 0;
async function run(token, fromSec, toSec, profitAt, running = true) {
  let res;
  for (t = fromSec + 30; t <= toSec; t += 30) {
    const target = profitAt(t);
    const delta = target - lastProfit; lastProfit = target;
    res = (await one(`select mod_heartbeat($1,$2,$3,$4,null,$5) r`, [token, ++seq, running, delta, at(t)])).r;
  }
  return res;
}
const win = async () => q(`select window_no, status, active_seconds, profit_delta::bigint, commission::bigint
                            from commission_windows where mc_account_id=$1 order by window_no`, [acc.id]);

console.log('\n[3] 50 dk calis, kapat, sonra 10 dk daha -> 60 dk dolar, %40');
// ilk 50 dk: kar 0 -> 50M (dogrusal)
await run(tok, 0, 3000, (s) => Math.round(50 * M * s / 3600));
let w = await win();
check('50. dakikada pencere ACIK, 3000 sn', w[0].status === 'OPEN' && w[0].active_seconds === 3000);
await q(`select mod_session_end($1,$2,false,0,null,$3)`, [tok, ++seq, at(3010)]);
// 2 saat kapali (sayilmaz), sonra yeni oturum + 10 dk
const tok2 = 'tok-' + randomUUID();
const startB = 3010 + 7200;
r = (await one(`select mod_session_start('Friend1',null,'AB12CD',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tok2, at(startB)])).r;
check('yeni oturum kaldigi yerden devam eder', r.window.no === 1 && r.window.active_seconds === 3000, `aktif ${r.window.active_seconds} sn`);
seq = 0;
const off = startB;  // kar: ilk saatin sonunda tam 50M
await run(tok2, off, off + 600, (s) => Math.round(50 * M * (3000 + (s - off)) / 3600));
w = await win();
check('60 dk aktif doldu -> 1. pencere KAPANDI (kapali 2 saat sayilmadi)', w[0].status === 'CLOSED' && w[0].active_seconds === 3600);
check('1. saat kari 50M -> komisyon 20M', Number(w[0].profit_delta) === 50 * M && Number(w[0].commission) === 20 * M,
      `kar ${w[0].profit_delta / M}M, komisyon ${w[0].commission / M}M`);

console.log('\n[4] 2. saat: toplam 150M -> yeni kar 100M -> komisyon 40M');
const off2 = off + 600;
await run(tok2, off2, off2 + 3600, (s) => 50 * M + Math.round(100 * M * (s - off2) / 3600));
w = await win();
check('2. pencere kapandi', w[1].status === 'CLOSED');
check('2. saat yeni kar 100M -> komisyon 40M', Number(w[1].profit_delta) === 100 * M && Number(w[1].commission) === 40 * M,
      `kar ${w[1].profit_delta / M}M, komisyon ${w[1].commission / M}M`);
const a1 = await one(`select profit_total, active_seconds_total from mc_accounts where id=$1`, [acc.id]);
check('toplam kar 150M, toplam aktif sure 2 saat', Number(a1.profit_total) === 150 * M && Number(a1.active_seconds_total) === 7200);

console.log('\n[5] Calismiyorken sure sayilmaz, tekrar gelen istek uygulanmaz, bosluk sinirli');
const tNow = off2 + 3600;
r = (await one(`select mod_heartbeat($1,$2,false,0,null,$3) r`, [tok2, ++seq, at(tNow + 30)])).r;
let w3 = (await win())[2];
check('running=false -> sure eklenmez', w3.active_seconds === 0);
r = (await one(`select mod_heartbeat($1,$2,true,${5 * M},null,$3) r`, [tok2, seq, at(tNow + 60)])).r;
check('ayni sira no tekrar gelirse uygulanmaz', r.duplicate === true &&
      Number((await one(`select profit_total from mc_accounts where id=$1`, [acc.id])).profit_total) === 150 * M);
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tok2, ++seq, at(tNow + 30 + 150)])).r;
w3 = (await win())[2];
check('150 sn bosluk -> en fazla 90 sn sayilir', w3.active_seconds === 90);
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tok2, ++seq, at(tNow + 30 + 150 + 2)])).r;
check('cok sik heartbeat (2 sn) yok sayilir', r.throttled === true);

console.log('\n[6] Bekleyen komisyon, vade gecince PAY_ONLY');
let due = r.due;
check('bekleyen borc 20M + 40M = 60M, en eski once', Number(due.total) === 60 * M && Number(due.items[0].remaining) === 20 * M);
check('odeme alicisi ayarlardan', due.pay_to === 'OpBank');
const late = tNow + 30 + 150 + 2 + 3 * 3600;   // ilk komisyondan > 120 dk sonra
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tok2, ++seq, at(tNow + 30 + 150 + 32)])).r;
const tokP = 'tok-' + randomUUID();
r = (await one(`select mod_session_start('Friend1',null,'AB12CD',$1,'sec','0.7.0','1.1.1.1',$2) r`, [tokP, at(late)])).r;
check('vadesi gecen borc -> oturum PAY_ONLY (sadece borc oder)', r.ok && r.mode === 'PAY_ONLY' && r.reason === 'COMMISSION_OVERDUE');

console.log('\n[7] Odeme: mod bildirir, alici dogrular');
const tx1 = randomUUID();
r = (await one(`select mod_report_payment($1,$2,'Someone',${20 * M},400000,'You paid Someone $20M',$3) r`, [tokP, tx1, at(late + 10)])).r;
check('yanlis aliciya odeme sayilmaz', r.ok === false && r.reason === 'WRONG_RECEIVER');
r = (await one(`select mod_report_payment($1,$2,'OpBank',${20 * M},400000,'You paid OpBank $ 20M (+ $ 400k tax)',$3) r`, [tokP, tx1, at(late + 10)])).r;
check('20M en eski komisyona dagitildi, durum CLAIMED', r.ok && r.status === 'CLAIMED' && Number(r.due.total) === 40 * M);
const r2 = (await one(`select mod_report_payment($1,$2,'OpBank',${20 * M},400000,'tekrar',$3) r`, [tokP, tx1, at(late + 12)])).r;
check('ayni islem no tekrar gelirse ikinci odeme yazilmaz', r2.duplicate === true &&
      Number((await one(`select count(*) c from payments`)).c) === 1);
// Alici hesap (operator) oturumu: kod istemez
const tokR = 'tok-' + randomUUID();
r = (await one(`select mod_session_start('OpBank',null,'',$1,'sec','0.7.0','2.2.2.2',$2) r`, [tokR, at(late)])).r;
check('operator hesabi KOD ISTEMEDEN acilir, muaf', r.ok && r.exempt === true);
r = (await one(`select mod_report_received($1,'Friend1',${20 * M},50000,'Friend1 paid you $20M',$2) r`, [tokR, at(late + 20)])).r;
const p1 = await one(`select status, verified_by from payments where client_tx_id=$1`, [tx1]);
check('"Friend1 paid you $20M" ile eslesti -> VERIFIED', p1.status === 'VERIFIED' && p1.verified_by === 'RECEIVER:OpBank');
const tokFake = 'tok-' + randomUUID();
await one(`select mod_session_start('OpMain',null,'',$1,'sec','0.7.0','3.3.3.3',$2) r`, [tokFake, at(late)]);
r = (await one(`select mod_report_received($1,'Friend1',${40 * M},0,'x',$2) r`, [tokFake, at(late + 30)])).r;
check('alici olmayan operator hesabi "aldim" diyemez', r.reason === 'NOT_RECEIVER');

console.log('\n[8] Operator odemeyi reddederse borc geri acilir');
const tx2 = randomUUID();
r = (await one(`select mod_report_payment($1,$2,'OpBank',${40 * M},800000,'You paid OpBank $40M',$3) r`, [tokP, tx2, at(late + 40)])).r;
check('40M odeme -> borc 0', Number(r.due.total) === 0);
const pid2 = (await one(`select id from payments where client_tx_id=$1`, [tx2])).id;
await q(`select admin_verify_payment($1,$2,false,'kasaya gelmedi')`, [OP, pid2]);
const debt = await one(`select pending_debt from v_account_overview where id=$1`, [acc.id]);
check('red -> 40M borc yeniden bekliyor', Number(debt.pending_debt) === 40 * M);

console.log('\n[9] Operator erisimi kapatinca bot aninda durur');
await q(`select admin_set_account_access($1,$2,false,'Komisyon odenmedi')`, [OP, acc.id]);
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tokP, 1, at(late + 60)])).r;
check('acik oturum kapatildi (heartbeat NO_SESSION)', r.ok === false && r.reason === 'NO_SESSION');
r = (await one(`select mod_session_start('Friend1',null,'AB12CD',$1,'sec','0.7.0','1.1.1.1',$2) r`, ['tok-' + randomUUID(), at(late + 70)])).r;
check('yeni oturum da reddedilir', r.ok === false && r.reason.includes('Komisyon odenmedi'), r.reason);

console.log('\n[10] Operator hesabi: komisyon uretmez');
let s2 = 0;
for (let k = 1; k <= 130; k++) {   // 65 dk, 200M kar
  await q(`select mod_heartbeat($1,$2,true,$3,null,$4)`, [tokR, ++s2, Math.round(200 * M / 130), at(late + 30 * k)]);
}
const opa = await one(`select profit_total, active_seconds_total from operator_mc_accounts where lower(mc_name)='opbank'`);
check('kar/sure istatistigi tutulur', Number(opa.profit_total) > 199 * M && Number(opa.active_seconds_total) >= 3600);
check('hic pencere / komisyon yok', Number((await one(`select count(*) c from commissions c join mc_accounts a on a.id=c.mc_account_id where lower(a.mc_name)='opbank'`)).c) === 0);
let err = '';
try { await q(`select member_add_account($1,'OpMain')`, [U2]); } catch (e) { err = e.message; }
check('operator hesabi uye hesabi olarak eklenemez', err.includes('NAME_IS_OPERATOR_ACCOUNT'));

console.log('\n[11] Zarar eden saat komisyon uretmez');
const acc2 = await one(`select id from mc_accounts where mc_name='Other2'`);
await q(`select admin_set_account_access($1,$2,true,null)`, [OP, acc2.id]); await q(`select member_consent($1)`, [U2]);
await q(`select get_or_create_daily_code($1,'LOSS01',$2)`, [acc2.id, at(0)]);
const tokL = 'tok-' + randomUUID();
await one(`select mod_session_start('Other2',null,'LOSS01',$1,'s','0.7.0','x',$2)`, [tokL, at(0)]);
for (let k = 1; k <= 121; k++) await q(`select mod_heartbeat($1,$2,true,$3,null,$4)`, [tokL, k, -100000, at(30 * k)]);
const lw = await one(`select profit_delta::bigint d, commission::bigint c from commission_windows where mc_account_id=$1 and window_no=1`, [acc2.id]);
check('saat zararla kapandi -> komisyon 0, borc yazilmadi', Number(lw.d) < 0 && Number(lw.c) === 0 &&
      Number((await one(`select count(*) c from commissions where mc_account_id=$1`, [acc2.id])).c) === 0);

console.log('\n[12] Yetkiler (RLS)');
async function asUser(uid, sql) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false);`);
  try { return (await db.query(sql)).rows; } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false);`); }
}
const v1 = await asUser(U1, `select mc_name, pending_debt from v_account_overview`);
check('UYE sadece kendi hesabini gorur', v1.length === 1 && v1[0].mc_name === 'Friend1');
check('UYE operator hesap listesini goremez', (await asUser(U1, `select * from operator_mc_accounts`)).length === 0);
check('UYE baskasinin komisyonunu goremez', (await asUser(U2, `select * from commissions where mc_account_id='${acc.id}'`)).length === 0);
check('OPERATOR her hesabi gorur', (await asUser(OP, `select * from v_account_overview`)).length === 2);
check('OPERATOR operator hesaplarini gorur', (await asUser(OP, `select * from operator_mc_accounts`)).length === 2);
err = '';
try { await asUser(U1, `update commissions set status='PAID'`); } catch (e) { err = e.message; }
check('UYE tabloya dogrudan yazamaz (borcunu silemez)', err.length > 0, err.split('\n')[0]);
err = '';
try { await asUser(U1, `select token_hash from bot_sessions`); } catch (e) { err = e.message; }
check('UYE oturum gizlilerini (token/hmac) okuyamaz', err.length > 0);
err = '';
try { await q(`select admin_set_account_access($1,$2,true,null)`, [U1, acc.id]); } catch (e) { err = e.message; }
check('UYE operator fonksiyonu calistiramaz (erisimini kendi acamaz)', err.includes('FORBIDDEN'));

console.log('\n[13] Guvenlik / kurcalama');
await one(`select * from member_add_account($1,'Third3')`, [U2]);
const acc3 = await one(`select id from mc_accounts where mc_name='Third3'`);
await q(`select admin_set_account_access($1,$2,true,null)`, [OP, acc3.id]);
await q(`select get_or_create_daily_code($1,'SEC001',$2)`, [acc3.id, at(0)]);
const tokS = 'tok-' + randomUUID();
r = (await one(`select mod_session_start('Third3',null,'SEC001',$1,'s','0.7.0','9.9.9.9',$2) r`, [tokS, at(0)])).r;
check('yeni uye oturumu acildi', r.ok && r.mode === 'FULL');
r = (await one(`select mod_report_integrity($1,$2) r`, [tokS, { jarSha256: 'AAA', agents: [], debugger: false, devEnv: false, initial: true }])).r;
let ev = await one(`select * from v_security_events order by id desc limit 1`);
check('izin listesi bos -> INTEGRITY_OK (INFO), kod numarasi baglandi', r.ok && ev.kind === 'INTEGRITY_OK' && ev.daily_code === 'SEC001' && ev.mc_name === 'Third3');
await q(`select admin_set_setting($1,'allowed_mod_hashes','["aaa"]')`, [OP]);
r = (await one(`select mod_report_integrity($1,$2) r`, [tokS, { jarSha256: 'aaa' }])).r;
check('izinli hash -> bayrak yok', r.flags.length === 0);
r = (await one(`select mod_report_integrity($1,$2) r`, [tokS, { jarSha256: 'bbb' }])).r;
ev = await one(`select * from security_events order by id desc limit 1`);
let a3 = await one(`select tamper_flag, access_enabled from mc_accounts where id=$1`, [acc3.id]);
check('degistirilmis jar -> CRITICAL kayit, LOG modunda islem yok', r.flags[0] === 'JAR_HASH_MISMATCH' && ev.severity === 'CRITICAL'
      && ev.action_taken === 'LOGGED' && !a3.tamper_flag);
await q(`select admin_set_setting($1,'tamper_action','"PAY_ONLY"')`, [OP]);
await q(`select mod_report_integrity($1,$2)`, [tokS, { jarSha256: 'aaa', debugger: true }]);
let sq = 0;
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tokS, ++sq, at(30)])).r;
check('PAY_ONLY modunda debugger -> hesap isaretlendi, oturum sadece-odeme', r.mode === 'PAY_ONLY' && r.reason.startsWith('TAMPER_REVIEW'), r.reason);
await q(`select admin_clear_tamper($1,$2)`, [OP, acc3.id]);
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tokS, ++sq, at(60)])).r;
check('operator bayragi kaldirinca tekrar FULL', r.mode === 'FULL');
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tokS, 1, at(90)])).r;
ev = await one(`select * from security_events order by id desc limit 1`);
check('geri giden sira no -> SEQ_REGRESSION kaydi', r.duplicate === true && ev.kind === 'SEQ_REGRESSION');
// bakiye-kar tutarsizligi: 1 saatte bakiye 10M -> 100M ama bildirilen kar 1M
await q(`select admin_set_setting($1,'tamper_action','"LOG"')`, [OP]);
for (let k = 3; k <= 125; k++) {
  const bal = k === 3 ? 10 * M : (k >= 120 ? 100 * M : null);
  await q(`select mod_heartbeat($1,$2,true,$3,$4,$5)`, [tokS, ++sq, k === 50 ? 1 * M : 0, bal, at(30 * k)]);
}
ev = await one(`select * from security_events where kind='BALANCE_PROFIT_MISMATCH' order by id desc limit 1`);
check('bakiye 90M artti, kar 1M bildirildi -> BALANCE_PROFIT_MISMATCH uyarisi', ev && ev.severity === 'WARN'
      && Number(ev.detail.unexplained) === 89 * M, ev ? `aciklanamayan ${ev.detail.unexplained / M}M` : 'yok');
await q(`select admin_set_setting($1,'tamper_action','"BLOCK"')`, [OP]);
r = (await one(`select mod_report_integrity($1,$2) r`, [tokS, { jarSha256: 'aaa', agents: ['-javaagent:x.jar'] }])).r;
a3 = await one(`select tamper_flag, access_enabled, blocked_reason from mc_accounts where id=$1`, [acc3.id]);
r = (await one(`select mod_heartbeat($1,$2,true,0,null,$3) r`, [tokS, ++sq, at(30 * 130)])).r;
check('BLOCK modunda java agent -> erisim kapandi, oturum bitti', !a3.access_enabled && a3.tamper_flag && r.ok === false, a3.blocked_reason);
const evCountBefore = (await one(`select count(*)::int n from security_events`)).n;
r = (await one(`select mod_report_events($1,$2) r`, [tokR, [{ kind: 'noise', severity: 'WARN', detail: {} }]])).r;
check('operator hesabi varsayilanda guvenlik logu uretmez (0005)', (await one(`select count(*)::int n from security_events`)).n === evCountBefore);
await q(`select admin_set_setting($1,'log_operator_accounts','true')`, [OP]);
r = (await one(`select mod_report_events($1,$2) r`, [tokR, [{ kind: 'runtime_agent', severity: 'CRITICAL', detail: { x: 1 } }]])).r;
ev = await one(`select * from security_events order by id desc limit 1`);
check('istemci olay bildirimi en fazla WARN, operator hesabinda islem yok', r.logged === 1 && ev.kind === 'CLIENT_RUNTIME_AGENT'
      && ev.severity === 'WARN' && ev.operator_account_id !== null);
const stR = (await one(`select _session_state(id, now()) r from bot_sessions where token_hash=$1`, [tokR])).r;
const stF = (await one(`select _session_state(id, now()) r from bot_sessions where token_hash=$1`, [tokFake])).r;
check('kasa hesabi oturumu receiver=true, diger operator hesabi false', stR.receiver === true && stF.receiver === false);
check('UYE guvenlik loglarini goremez', (await asUser(U1, `select * from v_security_events`)).length === 0);
check('OPERATOR guvenlik loglarini gorur', (await asUser(OP, `select * from v_security_events`)).length >= 6);
await q(`select admin_set_setting($1,'log_operator_accounts','false')`, [OP]);

console.log('\n[14] Rutbeler, siparis, yukseltme, hediye (0005)');
await db.exec(`update ranks set commission_rate = 0.50 where code = 'BRONZE'`);
const N0 = new Date('2026-12-01T09:00:00Z');
const nt = (sec) => new Date(N0.getTime() + sec * 1000).toISOString();
const DAY = 86400, WEEK = 7 * DAY;
const U3 = randomUUID();
await q(`insert into auth.users (id, email) values ($1,'u3@x')`, [U3]);
await q(`select member_consent($1)`, [U3]);
await q(`select * from member_add_account($1,'Rank3')`, [U3]);
const acc4 = await one(`select id from mc_accounts where mc_name='Rank3'`);
await q(`select admin_set_account_access($1,$2,true,null)`, [OP, acc4.id]);
const rate = async (t) => Number((await one(`select user_commission_rate($1,$2) r`, [U3, t])).r);
check('varsayilan rutbe Bronze %50', (await one(`select rank_status($1,$2) r`, [U3, nt(0)])).r.code === 'BRONZE' && await rate(nt(0)) === 0.5);
let qt = (await one(`select rank_quote($1,'GOLD',3,$2) r`, [U3, nt(0)])).r;
check('Gold 3 hafta = 3 x 80M = 240M, sure 21 gun', qt.kind === 'PURCHASE' && Number(qt.amount) === 240 * M
      && new Date(qt.ends_at).getTime() === N0.getTime() + 3 * WEEK * 1000, `${qt.amount}`);
check('Bronze satin alinamaz', (await one(`select rank_quote($1,'BRONZE',1,$2) r`, [U3, nt(0)])).r.reason === 'INVALID_RANK');
let ord = (await one(`select member_create_rank_order($1,'GOLD',3,$2) r`, [U3, nt(0)])).r;
check('siparis PENDING, kasa OpBank', ord.status === 'PENDING' && ord.pay_to === 'OpBank' && Number(ord.amount) === 240 * M);
await q(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','Rank3',$1,0,$2)`, [240 * M, nt(10)]);
await q(`select match_extra_payments($1)`, [nt(60)]);
check('kasa odemesi 2 dk bekletilir (komisyon bildirimi once gelsin)', (await one(`select status from rank_orders where id=$1`, [ord.id])).status === 'PENDING');
await q(`select match_extra_payments($1)`, [nt(200)]);
ord = await one(`select * from rank_orders where id=$1`, [ord.id]);
check('kasa odemesi siparise eslesti -> PAID, Gold aktif %40', ord.status === 'PAID' && ord.paid_via === 'RECEIVER:OpBank' && await rate(nt(300)) === 0.4);
check('rutbe odemesi komisyon borcuna/odemelerine karismadi', (await one(`select count(*)::int n from payments where mc_account_id=$1`, [acc4.id])).n === 0);

// bot oturumu: pencere orani rutbeden gelir
await q(`select get_or_create_daily_code($1,'RANK33',$2)`, [acc4.id, nt(300)]);
const tok4 = 'tok-' + randomUUID();
r = (await one(`select mod_session_start('Rank3',null,'RANK33',$1,'s','0.7.0','2.2.2.2',$2) r`, [tok4, nt(300)])).r;
check('oturum durumu rutbe oranini gosterir (moda %40)', r.ok && Number(r.commission_rate) === 0.4);
let s4 = 0;
await q(`select mod_heartbeat($1,$2,true,$3,null,$4)`, [tok4, ++s4, 10 * M, nt(330)]);
await q(`select mod_heartbeat($1,$2,true,$3,null,$4)`, [tok4, ++s4, 5 * M, nt(360)]);

// 3 gun sonra Diamond'a yukseltme (Gold, odemenin eslestigi an nt(200)'de basladi)
const goldEnd = new Date((await one(`select ends_at from rank_grants where user_id=$1 and rank_code='GOLD'`, [U3])).ends_at).getTime();
const tUp = goldEnd / 1000 - 18 * DAY;                         // tam 18 gun kala
const tUpIso = new Date(tUp * 1000).toISOString();
qt = (await one(`select rank_quote($1,'DIAMOND',0,$2) r`, [U3, tUpIso])).r;
check('yukseltme farki = (150M-80M) x 18/7 gun = 180M', qt.kind === 'UPGRADE' && Number(qt.amount) === 180 * M
      && Number(qt.current_remaining_value) === Math.ceil(80 * M * 18 / 7) && Number(qt.remaining_seconds) === 18 * DAY, `${qt.amount}`);
const qt2 = (await one(`select rank_quote($1,'DIAMOND',1,$2) r`, [U3, tUpIso])).r;
check('yukseltme + 1 ek hafta = 180M + 150M', Number(qt2.amount) === 330 * M);
ord = (await one(`select member_create_rank_order($1,'DIAMOND',0,$2) r`, [U3, nt(3 * DAY)])).r;
await q(`select admin_rank_order_paid($1,$2,'kasada gordum',$3)`, [OP, ord.id, nt(3 * DAY + 60)]);
const gold = await one(`select * from rank_grants where user_id=$1 and rank_code='GOLD'`, [U3]);
const dia = await one(`select * from rank_grants where user_id=$1 and rank_code='DIAMOND'`, [U3]);
check('Gold SUPERSEDED, Diamond ayni bitis tarihine kadar', gold.status === 'SUPERSEDED'
      && new Date(dia.ends_at).getTime() === goldEnd && dia.source === 'UPGRADE' && Number(dia.price) === Number(ord.amount));
check('acik saatlik pencere orani hemen %30', Number((await one(`select rate from commission_windows where mc_account_id=$1 and status='OPEN'`, [acc4.id])).rate) === 0.3);
check('yukseltmeden sonra oran %30', await rate(nt(3 * DAY + 120)) === 0.3);

// hediye
await q(`select admin_gift_rank($1,$2,'AMETIS',7200,'etkinlik',$3)`, [OP, U3, nt(4 * DAY)]);
check('2 saatlik Ametis hediyesi -> %25', await rate(nt(4 * DAY + 60)) === 0.25
      && (await one(`select rank_status($1,$2) r`, [U3, nt(4 * DAY + 60)])).r.source === 'GIFT');
check('hediye bitince Diamond geri gelir', await rate(nt(4 * DAY + 7300)) === 0.3);
qt = (await one(`select rank_quote($1,'GOLD',1,$2) r`, [U3, nt(5 * DAY)])).r;
check('dusuk rutbe alimi ust rutbe bitince baslar (sira)', qt.kind === 'PURCHASE' && qt.queued === true
      && new Date(qt.starts_at).getTime() === goldEnd);
err = '';
try { await q(`select admin_gift_rank($1,$2,'GOLD',3600,null,null)`, [U3, U3]); } catch (e) { err = e.message; }
check('uye hediye veremez', err.includes('FORBIDDEN') || err.includes('OPERATOR') || err.length > 0, err);

console.log('\n[15] Odeme talepleri (0005)');
// 0006 ile olusturma kapatildi; eski kayitlarin eslesmesini dogrudan eklenen satirlarla test et
const req = (await one(`insert into payment_requests (user_id, amount, pay_to, note, created_by, created_at) values ($1,$2,'OpBank','turnuva katilim',$3,$4) returning id`, [U3, 5 * M, OP, nt(5 * DAY - 60)])).id;
await q(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','Rank3',$1,0,$2)`, [5 * M, nt(5 * DAY)]);
await q(`select match_extra_payments($1)`, [nt(5 * DAY + 180)]);
check('kasaya gelen 5M odeme talebini kapatti', (await one(`select status from payment_requests where id=$1`, [req])).status === 'PAID');
const req2 = (await one(`insert into payment_requests (user_id, mc_account_id, amount, pay_to, created_by, created_at) values ($1,$2,$3,'OpBank',$4,$5) returning id`, [U3, acc4.id, 7 * M, OP, nt(6 * DAY - 60)])).id;
await q(`insert into payments (mc_account_id, client_tx_id, to_player, amount, claimed_at) values ($1,$2,'OpBank',$3,$4)`,
        [acc4.id, randomUUID(), 7 * M, nt(6 * DAY)]);
await q(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','Rank3',$1,0,$2)`, [7 * M, nt(6 * DAY + 5)]);
await q(`select match_extra_payments($1)`, [nt(6 * DAY + 300)]);
check('ayni tutarda komisyon odemesi bekliyorsa gelen odeme talebe yazilmaz', (await one(`select status from payment_requests where id=$1`, [req2])).status === 'OPEN');
await q(`select admin_resolve_payment_request($1,$2,'CANCELLED','yanlislik')`, [OP, req2]);
check('operator talebi iptal edebilir', (await one(`select status from payment_requests where id=$1`, [req2])).status === 'CANCELLED');
check('UYE kendi taleplerini gorur, baskasi goremez',
      (await asUser(U3, `select * from payment_requests`)).length === 2 && (await asUser(U1, `select * from payment_requests`)).length === 0);
check('UYE kendi rutbe siparislerini gorur, baskasi goremez',
      (await asUser(U3, `select * from rank_orders`)).length === 2 && (await asUser(U2, `select * from rank_orders`)).length === 0);

console.log('\n[16] Kazanc kayitlari ve izole sifirlama (0005)');
let er = (await one(`select earnings_report($1,'MEMBER',null,$2) r`, [U3, nt(400)])).r;
let ra = er.accounts.find((x) => x.mc_name === 'Rank3');
check('heartbeat karlari islem kaydina dustu (2 kayit, 15M)', er.events.length === 2 && Number(ra.profit_since_reset) === 15 * M
      && Number(er.events[0].delta) === 5 * M);
check('son 1 saat = 15M, bugun = 15M', Number(ra.last_hour) === 15 * M && Number(ra.today) === 15 * M);
check('saatlik ve gunluk not', er.hourly.length === 1 && Number(er.hourly[0].profit) === 15 * M && er.daily.length === 1);
await q(`select view_reset($1,'MEMBER','STATS',null,$2)`, [U3, nt(500)]);
er = (await one(`select earnings_report($1,'MEMBER',null,$2) r`, [U3, nt(600)])).r;
let eo = (await one(`select earnings_report($1,'OPERATOR',$2,$3) r`, [OP, acc4.id, nt(600)])).r;
check('uye sifirladi -> uye gorunumu 0', er.events.length === 0 && Number(er.accounts[0].profit_since_reset) === 0);
check('uye sifirlamasi operatoru etkilemez (15M)', eo.events.length === 2 && Number(eo.accounts[0].profit_since_reset) === 15 * M);
check('STATS sifirlamasi kazanc notunu silmez', er.hourly.length === 1);
await q(`select view_reset($1,'OPERATOR','EARNINGS',null,$2)`, [OP, nt(700)]);
eo = (await one(`select earnings_report($1,'OPERATOR',$2,$3) r`, [OP, acc4.id, nt(800)])).r;
er = (await one(`select earnings_report($1,'MEMBER',null,$2) r`, [U3, nt(800)])).r;
check('operator kazanc notunu sifirladi -> operatorde bos, uyede duruyor', eo.hourly.length === 0 && er.hourly.length === 1);
check('veriler silinmedi (profit_events)', (await one(`select count(*)::int n from profit_events where mc_account_id=$1`, [acc4.id])).n === 2);
err = '';
try { await q(`select view_reset($1,'MEMBER','STATS',$2,null)`, [U3, acc.id]); } catch (e) { err = e.message; }
check('uye baskasinin hesabini sifirlayamaz', err.includes('ACCOUNT_NOT_OWNED'));
err = '';
try { await q(`select earnings_report($1,'OPERATOR',null,null)`, [U3]); } catch (e) { err = e.message; }
check('uye operator raporunu acamaz', err.length > 0);
const OP2 = randomUUID();
await q(`insert into auth.users (id, email) values ($1,'op2@x')`, [OP2]);
await q(`update profiles set role='OPERATOR' where id=$1`, [OP2]);
eo = (await one(`select earnings_report($1,'OPERATOR',$2,$3) r`, [OP2, acc4.id, nt(800)])).r;
check('her operatorun sifirlamasi kendine ait', eo.hourly.length === 1);

console.log('\n[17] Bot is emirleri: Odeme al / Bildirim (0006)');
const T7 = 7 * DAY;
// 0008: uzaktan odeme onayi artik sart degil (onay verilmeden olusturulabilir)
const job1 = (await one(`select admin_create_job($1,$2,'PAY',$3,'haftalik tahsilat',true,$4) id`, [OP, acc4.id, 20 * M, nt(T7)])).id;
check('uzaktan odeme onayi olmadan PAY emri olusturulabilir (0008)', Number(job1) > 0
      && (await one(`select remote_pay_consent_at from profiles where id=$1`, [U3])).remote_pay_consent_at === null);
err = '';
try { await q(`select admin_create_job($1,$2,'PAY',$3,null,true,$4)`, [OP, acc4.id, 1 * M, nt(T7)]); } catch (e) { err = e.message; }
check('ayni hesapta bitmemis PAY emri varken ikincisi olusmaz', err.includes('JOB_PENDING'));
let jl = (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 10)])).r;
check('mod 0.7.0 -> emir gonderilmez (eski mod anlamaz)', jl.length === 0);
await q(`update bot_sessions set mod_version='0.7.1' where token_hash=$1`, [tok4]);
jl = (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 20)])).r;
check('mod 0.7.1 -> PAY emri heartbeat ile gider (kasa, tutar, txId)', jl.length === 1 && jl[0].kind === 'PAY'
      && Number(jl[0].amount) === 20 * M && jl[0].payTo === 'OpBank' && jl[0].txId);
jl = (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 50)])).r;
check('mod almadi derse (RECEIVED yok) tekrar gonderilir', jl.length === 1
      && (await one(`select delivered_count from bot_jobs where id=$1`, [job1])).delivered_count === 2);
r = (await one(`select mod_job_ack($1,$2,'RECEIVED',null,null,null,$3) r`, [tok4, job1, nt(T7 + 51)])).r;
jl = (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 80)])).r;
check('RECEIVED sonrasi tekrar gonderilmez', r.ok && jl.length === 0);
err = '';
try { await q(`select admin_cancel_job($1,$2,null)`, [OP, job1]); } catch (e) { err = e.message; }
check('mod teslim aldiktan sonra iptal edilemez', err.includes('JOB_NOT_CANCELLABLE'));
const pBefore = (await one(`select count(*)::int n from payments where mc_account_id=$1`, [acc4.id])).n;
r = (await one(`select mod_job_ack($1,$2,'DONE',400000,'You paid OpBank $ 20M (+ $ 400k tax)',null,$3) r`, [tok4, job1, nt(T7 + 90)])).r;
const jrow = await one(`select * from bot_jobs where id=$1`, [job1]);
const prow = await one(`select * from payments where id=$1`, [jrow.payment_id]);
check('DONE + komisyona say -> payments kaydi (ayni txId), kasa dogrulamasi bekliyor', r.ok && jrow.status === 'DONE'
      && prow && prow.client_tx_id === jrow.tx_id && Number(prow.amount) === 20 * M && prow.status === 'CLAIMED'
      && (await one(`select count(*)::int n from payments where mc_account_id=$1`, [acc4.id])).n === pBefore + 1);
r = (await one(`select mod_job_ack($1,$2,'DONE',400000,'tekrar',null,$3) r`, [tok4, job1, nt(T7 + 95)])).r;
check('ayni sonuc tekrar gelirse ikinci odeme yazilmaz', r.duplicate === true
      && (await one(`select count(*)::int n from payments where mc_account_id=$1`, [acc4.id])).n === pBefore + 1);

// komisyona sayilmayan tahsilat + bekleyen rutbe siparisi ayni tutarda olsa bile karismaz
await q(`select admin_set_rank($1,'GOLD',0.40,80000000)`, [OP]);
const job2 = (await one(`select admin_create_job($1,$2,'PAY',$3,'turnuva',false,$4) id`, [OP, acc4.id, 80 * M, nt(T7 + 200)])).id;
const ord3 = (await one(`select member_create_rank_order($1,'AMETIS',1,$2) r`, [U3, nt(T7 + 200)])).r;
await q(`select mod_pull_jobs($1,$2)`, [tok4, nt(T7 + 210)]);
await q(`select mod_job_ack($1,$2,'RECEIVED',null,null,null,$3)`, [tok4, job2, nt(T7 + 211)]);
await q(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','Rank3',$1,0,$2)`, [80 * M, nt(T7 + 215)]);
await q(`select match_extra_payments($1)`, [nt(T7 + 500)]);
check('is emri sonucu gelmeden gelen odeme rutbe siparisine yazilmaz', (await one(`select status from rank_orders where id=$1`, [ord3.id])).status === 'PENDING');
await q(`select mod_job_ack($1,$2,'DONE',1600000,'You paid OpBank $ 80M',null,$3)`, [tok4, job2, nt(T7 + 520)]);
const j2 = await one(`select * from bot_jobs where id=$1`, [job2]);
check('komisyona sayilmayan tahsilat kasada dogrulandi, payments tablosuna yazilmadi', j2.verified_at !== null && j2.payment_id === null
      && (await one(`select count(*)::int n from received_payments where matched_job_id=$1`, [job2])).n === 1);
await q(`select member_cancel_rank_order($1,$2)`, [U3, ord3.id]);

const job3 = (await one(`select admin_create_job($1,$2,'NOTIFY',null,'Sunucu 10 dk sonra yeniden basliyor',true,$3) id`, [OP, acc4.id, nt(T7 + 600)])).id;
jl = (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 610)])).r;
check('Bildirim emri mesajla birlikte gider (onay gerektirmez)', jl.length === 1 && jl[0].kind === 'NOTIFY' && jl[0].message.includes('yeniden'));
await q(`select mod_job_ack($1,$2,'DONE',null,null,null,$3)`, [tok4, job3, nt(T7 + 611)]);
const job4 = (await one(`select admin_create_job($1,$2,'PAY',$3,null,true,$4) id`, [OP, acc4.id, 5 * M, nt(T7 + 700)])).id;
await q(`select admin_cancel_job($1,$2,null)`, [OP, job4]);
check('teslim edilmemis emir iptal edilir ve gonderilmez', (await one(`select mod_pull_jobs($1,$2) r`, [tok4, nt(T7 + 710)])).r.length === 0);
const job5 = (await one(`select admin_create_job($1,$2,'PAY',$3,null,true,$4) id`, [OP, acc4.id, 5 * M, nt(T7 + 800)])).id;
await q(`select mod_pull_jobs($1,$2)`, [tok4, nt(T7 + 800 + 31 * 60)]);
check('30 dk icinde teslim alinmayan emir EXPIRED', (await one(`select status from bot_jobs where id=$1`, [job5])).status === 'EXPIRED');
await q(`select mod_job_ack($1,$2,'RECEIVED',null,null,null,$3)`, [tok4, job5, nt(T7 + 800 + 32 * 60)]);
check('suresi dolan emri mod sonradan alsa bile calismaz', (await one(`select status from bot_jobs where id=$1`, [job5])).status === 'EXPIRED');
check('UYE kendi is emirlerini gorur, baskasi goremez', (await asUser(U3, `select * from bot_jobs`)).length >= 5
      && (await asUser(U1, `select * from bot_jobs`)).length === 0);
err = '';
try { await q(`select admin_create_payment_request($1,$2,null,$3,null,null)`, [OP, U3, M]); } catch (e) { err = e.message; }
check('odeme talebi olusturma devre disi', err.includes('DISABLED'));

console.log('\n[18] Urun bazli satis kayitlari (0006)');
const sales = [
  { id: randomUUID(), at: Date.parse(nt(T7 + 900)), itemId: 'minecraft:filled_map', itemName: 'Map', amount: 64, revenue: 450000,
    cost: 192000, tax: 9000, net: 249000, how: 'single' },
  { id: randomUUID(), at: Date.parse(nt(T7 + 960)), itemId: null, itemName: 'Diamond Helmet', amount: 1, revenue: 1200000,
    cost: 800000, tax: 24000, net: 376000, how: 'batch' },
];
r = (await one(`select mod_report_sales($1,$2) r`, [tok4, JSON.stringify(sales)])).r;
const rs2 = (await one(`select mod_report_sales($1,$2) r`, [tok4, JSON.stringify(sales)])).r;
check('satislar kaydedildi, tekrar gonderim cift kayit yapmaz', r === 2 && rs2 === 0);
check('bozuk kayit digerlerini engellemez', (await one(`select mod_report_sales($1,$2) r`, [tok4, JSON.stringify([{ id: 'x' }, { ...sales[0], id: randomUUID() }])])).r === 1);
let sr = (await one(`select sales_report($1,'OPERATOR',null,100,$2) r`, [OP, nt(T7 + 1000)])).r;
const map = sr.sales.find((x) => x.item_name === 'Map');
check('operator satis gecmisi: urun, adet, fiyat, birim, net', sr.sales.length === 3 && map.amount === 64 && Number(map.revenue) === 450000
      && Number(map.unit_price) === 7031 && Number(map.net) === 249000 && map.mc_name === 'Rank3' && map.owner_name);
// sunucu gelecekteki zaman damgalarini simdiye kirpar: ozeti gercek zamanla al
const srNow = (await one(`select sales_report($1,'OPERATOR',null,100,null) r`, [OP])).r;
check('urun ozeti (7 gun)', srNow.by_item.some((x) => x.item === 'Map' && Number(x.count) === 2 && Number(x.amount) === 128));
await q(`select view_reset($1,'MEMBER','STATS',null,$2)`, [U3, nt(T7 + 1100)]);
const srm = (await one(`select sales_report($1,'MEMBER',null,100,$2) r`, [U3, nt(T7 + 1200)])).r;
sr = (await one(`select sales_report($1,'OPERATOR',null,100,$2) r`, [OP, nt(T7 + 1200)])).r;
check('uye kendi satis listesini sifirlar, operator listesi etkilenmez', srm.sales.length === 0 && sr.sales.length === 3);
check('baskasi bu satislari goremez', (await asUser(U1, `select * from mod_sales`)).length === 0
      && (await asUser(U3, `select * from mod_sales`)).length === 3);

console.log('\n[19] +odeme korumasi (0007)');
err = '';
try { await q(`select admin_manual_payment($1,$2,$3,null)`, [OP, acc4.id, 10 * M]); } catch (e) { err = e.message; }
check('+odeme kanitsiz borc dusmez', err.includes('MANUAL_PAYMENT_NEEDS_PROOF'));
const rcv = (await one(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','Rank3',$1,0,now()) returning id`, [3 * M])).id;
const rcvOther = (await one(`insert into received_payments (receiver_mc, from_player, amount, tolerance, seen_at) values ('OpBank','BaskaOyuncu',$1,0,now()) returning id`, [3 * M])).id;
let un = (await one(`select admin_unmatched_received($1,$2) r`, [OP, acc4.id])).r;
check('kasada gorulen eslesmemis odeme listelenir (sadece bu oyuncunun)', un.some((x) => x.id === rcv) && !un.some((x) => x.id === rcvOther));
err = '';
try { await q(`select admin_manual_payment_from_received($1,$2,$3,null)`, [OP, acc4.id, rcvOther]); } catch (e) { err = e.message; }
check('baska oyuncunun odemesi bu hesaba sayilamaz', err.includes('RECEIVED_FROM_OTHER_PLAYER'));
const mp = (await one(`select admin_manual_payment_from_received($1,$2,$3,'kasada gordum') id`, [OP, acc4.id, rcv])).id;
const mpr = await one(`select * from payments where id=$1`, [mp]);
check('secilen kasa odemesi dogrulanmis odeme olarak kaydedildi ve baglandi', mpr.status === 'VERIFIED' && Number(mpr.amount) === 3 * M
      && (await one(`select matched_payment_id from received_payments where id=$1`, [rcv])).matched_payment_id === mp);
err = '';
try { await q(`select admin_manual_payment_from_received($1,$2,$3,null)`, [OP, acc4.id, rcv]); } catch (e) { err = e.message; }
check('ayni kasa odemesi ikinci kez kullanilamaz', err.includes('RECEIVED_ALREADY_USED'));
err = '';
try { await q(`select admin_manual_payment_from_received($1,$2,$3,null)`, [U3, acc4.id, rcvOther]); } catch (e) { err = e.message; }
check('uye bu islemi yapamaz', err.length > 0 && !err.includes('RECEIVED'));

console.log(`\nSONUC: ${ok} basarili, ${bad} hatali`);
process.exit(bad ? 1 : 0);
