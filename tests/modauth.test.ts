// Mod imza / token / kod yardimcilari. Calistir: node --experimental-strip-types tests/modauth.test.ts
import { dashUuid, newDailyCode, newSessionSecrets, sha256, sign, verifySignature } from '../src/lib/modauth.ts';

let ok = 0, bad = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? 'OK ' : 'XX '} ${n}`); c ? ok++ : bad++; };

console.log('\n[mod kimlik dogrulama]');
const s = newSessionSecrets();
check('token sunucuda sadece sha256 olarak saklanir', s.tokenHash === sha256(s.token) && s.tokenHash !== s.token);
const bodyStr = JSON.stringify({ seq: 7, running: true, profitDelta: 1500000 });
const sig = sign(s.hmacSecret, bodyStr);
check('dogru imza kabul', verifySignature(s.hmacSecret, bodyStr, sig));
check('govde degistirilirse (kar sisirme) red', !verifySignature(s.hmacSecret, bodyStr.replace('1500000', '9500000'), sig));
check('baska oturumun anahtariyla red', !verifySignature(newSessionSecrets().hmacSecret, bodyStr, sig));
check('bozuk/eksik imza red', !verifySignature(s.hmacSecret, bodyStr, null) && !verifySignature(s.hmacSecret, bodyStr, 'zz'));
const codes = new Set(Array.from({ length: 2000 }, () => newDailyCode()));
check('gunluk kod bicimi XXXX-XXXX, karisan karakter yok (0/O/1/I)', [...codes].every((c) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c)));
check('2000 koddan cakisma yok', codes.size === 2000);
check('Mojang UUID tiresiz -> standart', dashUuid('069a79f444e94726a5befca90e38aaf5') === '069a79f4-44e9-4726-a5be-fca90e38aaf5');
console.log(`\nSONUC: ${ok} basarili, ${bad} hatali`);
process.exit(bad ? 1 : 0);
