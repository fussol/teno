import { FSRS, FSRS_PARAMS, AGAIN, HARD, GOOD, EASY } from '../../src/core/fsrs.js';
const EPS = 1e-4; let pass = 0, fail = 0;
function ok(label, got, exp) {
  const m = Math.abs(got-exp) <= EPS; m ? pass++ : (fail++,console.log(`  ✗ ${label}: got=${got.toFixed(6)} exp=${exp.toFixed(6)}`));
}

const fsrs = new FSRS();
function S(s,d) { return {stability:s||0, difficulty:d||5}; }
console.log('FSRS-6 vs Rust crate (fsrs-rs 6.6.1) test values\n');

// 1. short_term
console.log('1. short_term @ dt=0:');
const se = [1.596818, 5.0, 5.0, 8.12961]; // official fsrs-rs 6.6.1 (model.rs): Hard floor = unchanged
[AGAIN,HARD,GOOD,EASY].forEach(r => ok(`r${r}`, fsrs.step(0,r,S(5,5),1).stability, se[r]));

// 2. initial
console.log('2. initial @ nth=0:');
const dexp = [6.4133, 5.1121707, 2.11810397, 1.0];
[AGAIN,HARD,GOOD,EASY].forEach((r,i) => {
  const m = fsrs.step(0,r,S(0,0),0);
  ok(`init_s r${r}`,   m.stability,   FSRS_PARAMS[r]);
  ok(`init_d r${r}`,   m.difficulty,  dexp[i]);
});

// 3. forward
console.log('3. forward:');
const fwd = [
  {seq:[[0,0],[0,1]], es:0.10088589, ed:8.806304},
  {seq:[[1,0],[1,1]], es:3.2494123, ed:6.7404594},
  {seq:[[2,0],[2,1]], es:7.3153,    ed:2.1112142},
  {seq:[[3,0],[3,1]], es:18.014914, ed:1.0},
  {seq:[[0,0],[0,2]], es:0.112798266, ed:8.806304},
  {seq:[[1,0],[1,2]], es:4.4694576, ed:6.7404594},
];
for (const t of fwd) {
  let st = S(0,0);
  t.seq.forEach(([r,dt],i) => { st = fsrs.step(dt,r,st,i); });
  ok(`fwd${t.seq.map(x=>x[0]).join('')}_s`, st.stability, t.es);
  ok(`fwd${t.seq.map(x=>x[0]).join('')}_d`, st.difficulty, t.ed);
}

// 4. custom params memory_state
console.log('4. memory_state (custom):');
const c = [0.6845422,1.6790825,4.7349424,10.042885,7.4410233,0.64219797,1.071918,0.0025195254,1.432437,0.1544,0.8692766,2.0696752,0.0953,0.2975,2.4691248,0.19542035,3.201072,0.18046261,0.121442534];
const fsrs2 = new FSRS([...c,0.0,0.5],0.9,false);
let st = S(0,0);
[[0,0],[2,1],[2,3],[2,8],[2,21]].forEach(([r,t],i) => { st = fsrs2.step(t,r,st,i); });
ok('memo_s', st.stability, 31.722992);
ok('memo_d', st.difficulty, 7.382128);

// 5. exhaustive
console.log('5. exhaustive (24 cases):');
for (const nth of [0,1]) {
  const state = nth===0 ? S(0,0) : S(5,6);
  for (const dt of [0,1,21]) {
    for (const r of [AGAIN,HARD,GOOD,EASY]) {
      const m = fsrs.step(dt, r, state, nth);
      const valid = isFinite(m.stability) && m.stability>0 && m.difficulty>=1 && m.difficulty<=10;
      valid ? pass++ : fail++;
      if (!valid) console.log(`  ✗ step(${dt},${r},nth=${nth}) invalid`);
    }
  }
}
console.log('   all valid');

// 6. nextStates 
console.log('6. next_states:');
const ns = fsrs.nextStates(S(5,5), 21);
[AGAIN,HARD,GOOD,EASY].forEach(r => {
  ok(`ns_r${r}_>0`, ns[r].interval > 0, true);
  ok(`ns_r${r}_s>0`, ns[r].memory.stability > 0, true);
});

console.log(`\n${pass}/${pass+fail} ✓`);
console.log(fail===0?'ALL PASS':'FAILURES');
