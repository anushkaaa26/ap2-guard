'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  ShieldCheck, Play, RefreshCw, Check, AlertTriangle, Radio, FileJson2,
  ListChecks, Lock, Unlock, Fingerprint, Zap, Crosshair, Terminal,
  ArrowRight, ScanLine, ShieldAlert, Activity,
} from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */
type LineItem = { t: string; p: number; ancillary?: boolean };
type IntentSpec = {
  max_amount_cents: number; allowed_mccs: string[]; dest_iata: string[];
  min_refundability?: string; allow_ancillary?: boolean;
};
type CartMandate = {
  total_cents: number; merchant_mcc: string; dest_iata: string;
  refundability: string; items: LineItem[];
};
type Scenario = {
  id: string; n: string; tag: string; attack: boolean; threat: 0 | 1 | 2 | 3;
  name: string; desc: string; intent: IntentSpec; cart: CartMandate;
};
type Rule = {
  key: string; name: string; expr: string; pass: boolean; fields: string[];
};
type Verdict = { approved: boolean; reason: string; latency: string } | null;
type LogTone = 'dim' | 'ok' | 'bad' | 'warn';

/* ═══════════════════════════════════════════════════════════════
   Fixtures
   ═══════════════════════════════════════════════════════════════ */
const SCENARIOS: Scenario[] = [
  {
    id: 'benign', n: '01', tag: 'normal flow', attack: false, threat: 0,
    name: 'Benign flight booking — Tokyo NRT',
    desc: 'Standard agent booking that matches the signed intent exactly.',
    intent: { max_amount_cents: 50000, allowed_mccs: ['4511'], dest_iata: ['NRT', 'HND'], min_refundability: 'refundable_only' },
    cart: { total_cents: 45000, merchant_mcc: '4511', dest_iata: 'NRT', refundability: 'refundable', items: [{ t: 'DEL–NRT economy', p: 45000 }] },
  },
  {
    id: 'swap', n: '02', tag: 'IPI payload hijack', attack: true, threat: 3,
    name: 'Destination swap — Tokyo to Miami',
    desc: 'Compromised agent rewrites the destination under the same airline MCC.',
    intent: { max_amount_cents: 50000, allowed_mccs: ['4511'], dest_iata: ['NRT', 'HND'], min_refundability: 'refundable_only' },
    cart: { total_cents: 45000, merchant_mcc: '4511', dest_iata: 'MIA', refundability: 'refundable', items: [{ t: 'DEL–MIA economy', p: 45000 }] },
  },
  {
    id: 'fee', n: '03', tag: 'line-item smuggling', attack: true, threat: 2,
    name: 'Hidden ancillary fee padding',
    desc: 'Valid base fare bundled with an unauthorized concierge fee.',
    intent: { max_amount_cents: 50000, allowed_mccs: ['4511'], dest_iata: ['NRT', 'HND'], allow_ancillary: false },
    cart: { total_cents: 45000, merchant_mcc: '4511', dest_iata: 'NRT', refundability: 'refundable', items: [{ t: 'base fare', p: 30000 }, { t: 'VIP concierge fee', p: 15000, ancillary: true }] },
  },
  {
    id: 'refund', n: '04', tag: 'parameter tampering', attack: true, threat: 2,
    name: 'Refundability downgrade',
    desc: 'Cheaper non-refundable ticket bought against explicit intent.',
    intent: { max_amount_cents: 50000, allowed_mccs: ['4511'], dest_iata: ['NRT', 'HND'], min_refundability: 'refundable_only' },
    cart: { total_cents: 42000, merchant_mcc: '4511', dest_iata: 'NRT', refundability: 'non_refundable', items: [{ t: 'DEL–NRT basic', p: 42000 }] },
  },
];

const REASON_CODE: Record<string, string> = {
  dest: 'DECLINED_DESTINATION_MISMATCH',
  refund: 'DECLINED_REFUNDABILITY_VIOLATION',
  ancillary: 'DECLINED_UNAUTHORIZED_ANCILLARY_FEES',
};

const THREAT_META = [
  { label: 'CLEAN', color: 'var(--ok)' },
  { label: 'LOW', color: 'var(--accent)' },
  { label: 'ELEVATED', color: 'var(--warn)' },
  { label: 'CRITICAL', color: 'var(--bad)' },
];

function deriveRules(s: Scenario): Rule[] {
  const { intent: i, cart: c } = s;
  const hasAncillary = c.items.some((x) => x.ancillary);
  const rules: Rule[] = [
    { key: 'amount', name: 'amount_within_cap', expr: `${c.total_cents} ≤ ${i.max_amount_cents}`, pass: c.total_cents <= i.max_amount_cents, fields: ['c_total', 'c_totalv'] },
    { key: 'mcc', name: 'mcc_allowed', expr: `${c.merchant_mcc} ∈ [${i.allowed_mccs.join(', ')}]`, pass: i.allowed_mccs.includes(c.merchant_mcc), fields: ['c_mcc', 'c_mccv', 'i_mcc', 'i_mccv'] },
    { key: 'dest', name: 'destination_match', expr: `${c.dest_iata} ∈ [${i.dest_iata.join(', ')}]`, pass: i.dest_iata.includes(c.dest_iata), fields: ['c_dest', 'c_destv', 'i_dest', 'i_destv', 'c_item0'] },
  ];
  if (i.min_refundability) {
    rules.push({ key: 'refund', name: 'refundability_floor', expr: `${c.refundability} ≥ ${i.min_refundability}`, pass: i.min_refundability === 'refundable_only' && c.refundability === 'refundable', fields: ['c_ref', 'c_refv', 'i_ref', 'i_refv'] });
  }
  if (i.allow_ancillary === false) {
    rules.push({ key: 'ancillary', name: 'no_unauthorized_ancillary', expr: hasAncillary ? 'ancillary line item present' : 'no ancillary line items', pass: !hasAncillary, fields: ['c_itemA'] });
  }
  return rules;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════════════════════════
   JSON panes — hand-rendered so fields can be flash-targeted
   ═══════════════════════════════════════════════════════════════ */
const P   = ({ children }: { children: React.ReactNode }) => <span style={{ color: 'var(--text-4)' }}>{children}</span>;
const K   = ({ t, f }: { t: string; f?: string }) => <span data-f={f} className="json-line" style={{ color: 'var(--accent)' }}>&quot;{t}&quot;</span>;
const VN  = ({ t, f }: { t: string; f?: string }) => <span data-f={f} className="json-line num" style={{ color: 'var(--warn)' }}>{t}</span>;
const VS  = ({ t, f }: { t: string; f?: string }) => <span data-f={f} className="json-line" style={{ color: '#9ece8a' }}>&quot;{t}&quot;</span>;
const IND = <span>&nbsp;&nbsp;</span>;

function IntentPane({ s }: { s: Scenario }) {
  const i = s.intent;
  return (
    <div className="font-mono text-[12px] leading-[1.8]" style={{ color: 'var(--text-2)', overflowX: 'auto' }}>
      <P>{'{'}</P><br />
      {IND}<K t="max_amount_cents" f="i_max" /><P>: </P><VN t={String(i.max_amount_cents)} f="i_maxv" /><P>,</P><br />
      {IND}<K t="allowed_mccs" f="i_mcc" /><P>: </P><span data-f="i_mccv" className="json-line"><P>[</P>{i.allowed_mccs.map((m, ix) => <React.Fragment key={m}>{ix > 0 && <P>, </P>}<VS t={m} /></React.Fragment>)}<P>]</P></span><P>,</P><br />
      {IND}<K t="dest_iata" f="i_dest" /><P>: </P><span data-f="i_destv" className="json-line"><P>[</P>{i.dest_iata.map((m, ix) => <React.Fragment key={m}>{ix > 0 && <P>, </P>}<VS t={m} /></React.Fragment>)}<P>]</P></span><P>,</P><br />
      {i.min_refundability && <>{IND}<K t="min_refundability" f="i_ref" /><P>: </P><VS t={i.min_refundability} f="i_refv" /><P>,</P><br /></>}
      {i.allow_ancillary === false && <>{IND}<K t="allow_ancillary" f="i_anc" /><P>: </P><VS t="false" f="i_ancv" /><br /></>}
      <P>{'}'}</P>
    </div>
  );
}

function CartPane({ s }: { s: Scenario }) {
  const c = s.cart;
  return (
    <div className="font-mono text-[12px] leading-[1.8]" style={{ color: 'var(--text-2)', overflowX: 'auto' }}>
      <P>{'{'}</P><br />
      {IND}<K t="total_cents" f="c_total" /><P>: </P><VN t={String(c.total_cents)} f="c_totalv" /><P>,</P><br />
      {IND}<K t="merchant_mcc" f="c_mcc" /><P>: </P><VS t={c.merchant_mcc} f="c_mccv" /><P>,</P><br />
      {IND}<K t="dest_iata" f="c_dest" /><P>: </P><VS t={c.dest_iata} f="c_destv" /><P>,</P><br />
      {IND}<K t="refundability" f="c_ref" /><P>: </P><VS t={c.refundability} f="c_refv" /><P>,</P><br />
      {IND}<K t="line_items" /><P>: [</P><br />
      {c.items.map((it, ix) => (
        <React.Fragment key={ix}>
          {IND}{IND}<P>{'{ '}</P><K t="item_title" /><P>: </P>
          <VS t={it.t} f={it.ancillary ? 'c_itemA' : ix === 0 ? 'c_item0' : 'c_itemN'} /><P>, </P>
          <K t="price_cents" /><P>: </P><VN t={String(it.p)} f={it.ancillary ? 'c_itemA' : ix === 0 ? 'c_item0' : 'c_itemN'} />
          {it.ancillary && <><P>, </P><K t="is_ancillary" /><P>: </P><VS t="true" f="c_itemA" /></>}<P>{' }'}</P>{ix < c.items.length - 1 && <P>,</P>}<br />
        </React.Fragment>
      ))}
      {IND}<P>]</P><br />
      <P>{'}'}</P>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Small presentational atoms
   ═══════════════════════════════════════════════════════════════ */
function ThreatMeter({ level }: { level: 0 | 1 | 2 | 3 }) {
  return (
    <span className="inline-flex items-center gap-[3px]" title={`threat: ${THREAT_META[level].label}`}>
      {[1, 2, 3].map((d) => (
        <span
          key={d}
          className={d <= level ? 'threat-dot' : ''}
          style={{
            width: 4, height: 4, borderRadius: 1, display: 'inline-block',
            background: d <= level ? THREAT_META[level].color : 'var(--line)',
            animationDelay: `${d * 0.18}s`,
          }}
        />
      ))}
    </span>
  );
}

function PipelineViz({ stage }: { stage: 'idle' | 'verify' | 'diff' | 'rules' | 'done'; approved?: boolean }) {
  const nodes = [
    { label: 'INTENT', icon: <Fingerprint size={12} /> },
    { label: 'AST DIFF', icon: <ScanLine size={12} /> },
    { label: 'VERDICT', icon: <ShieldCheck size={12} /> },
  ];
  const activeIx = stage === 'verify' ? 0 : stage === 'diff' ? 1 : stage === 'rules' ? 1 : stage === 'done' ? 2 : -1;
  return (
    <div className="flex items-center gap-1.5 select-none">
      {nodes.map((n, ix) => (
        <React.Fragment key={n.label}>
          {ix > 0 && (
            <svg width="22" height="6" viewBox="0 0 22 6" className="shrink-0">
              <line x1="0" y1="3" x2="22" y2="3" stroke={activeIx >= ix ? 'var(--accent)' : 'var(--line)'} strokeWidth="1.5" className={activeIx >= ix ? 'dash-flow' : ''} />
            </svg>
          )}
          <span
            className={`flex items-center gap-1 font-mono text-[10px] px-1.5 py-[3px] rounded transition-all duration-300 ${activeIx === ix ? 'node-pulse' : ''}`}
            style={{
              color: activeIx >= ix ? 'var(--accent)' : 'var(--text-4)',
              border: `1px solid ${activeIx >= ix ? 'rgba(122,162,247,0.5)' : 'var(--line)'}`,
              background: activeIx === ix ? 'var(--accent-dim)' : 'transparent',
            }}
          >
            {n.icon}{n.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════ */
export default function AP2GuardConsole() {
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ruleState, setRuleState] = useState<('pending' | 'pass' | 'fail')[]>([]);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [stage, setStage] = useState<'idle' | 'verify' | 'diff' | 'rules' | 'done'>('idle');
  const [log, setLog] = useState<{ ts: string; tone: LogTone; html: string }[]>([]);
  const [reqId, setReqId] = useState('req_—');
  const [p99, setP99] = useState(0.24);
  const [blockedCount, setBlockedCount] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const s = SCENARIOS[sel];
  const rules = deriveRules(s);

  useEffect(() => {
    const t = setInterval(() => setP99(0.20 + Math.random() * 0.09), 2200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [log]);

  /* keyboard shortcut: R = run */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && !busy && !(e.target as HTMLElement)?.closest('input,textarea')) run();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, sel]);

  const stamp = () => {
    const d = new Date();
    return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };

  const flash = useCallback((fields: string[], ok: boolean) => {
    fields.forEach((f) => {
      document.querySelectorAll(`[data-f="${f}"]`).forEach((el) => {
        el.classList.remove('hit-bad', 'hit-ok');
        void (el as HTMLElement).offsetWidth;
        el.classList.add(ok ? 'hit-ok' : 'hit-bad');
      });
    });
  }, []);

  const loadScenario = (ix: number) => {
    if (busy) return;
    setSel(ix);
    setRuleState([]);
    setVerdict(null);
    setLog([]);
    setReqId('req_—');
    setStage('idle');
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setRuleState(rules.map(() => 'pending'));
    setVerdict(null);
    setReqId(`req_${Math.random().toString(16).slice(2, 8)}`);
    setStage('verify');
    setLog([{ ts: stamp(), tone: 'dim', html: '<span style="color:var(--accent)">▸</span> POST /v1/authorize · stripe issuing webhook' }]);
    await sleep(240);
    setLog((l) => [...l, { ts: stamp(), tone: 'ok', html: '<span style="color:var(--ok)">✓</span> intent verified · wysiwys passkey binding ok' }]);
    await sleep(200);
    setStage('diff');
    setLog((l) => [...l, { ts: stamp(), tone: 'dim', html: `<span style="color:var(--warn)">≋</span> ast diff · ${rules.length} invariants queued` }]);

    const states: ('pending' | 'pass' | 'fail')[] = rules.map(() => 'pending');
    let failed: Rule | null = null;
    for (let ix = 0; ix < rules.length; ix++) {
      const r = rules[ix];
      await sleep(150);
      flash(r.fields, r.pass);
      states[ix] = r.pass ? 'pass' : 'fail';
      setRuleState([...states]);
      if (!r.pass) {
        failed = r;
        setLog((l) => [...l, { ts: stamp(), tone: 'bad', html: `<span style="color:var(--bad)">✗</span> rule <b>${r.name}</b> · <span style="color:var(--bad)">FAILED</span>` }]);
        await sleep(160);
      } else {
        setLog((l) => [...l, { ts: stamp(), tone: 'dim', html: `<span style="color:var(--ok)">✓</span> rule ${r.name} · ok` }]);
      }
    }
    setStage('done');
    const approved = !failed;
    const reason = approved ? 'APPROVED_MATCHED' : REASON_CODE[failed!.key];
    const latency = (0.08 + Math.random() * 0.22).toFixed(2);
    setLog((l) => [...l, { ts: stamp(), tone: approved ? 'ok' : 'bad', html: `verdict · <b>${reason}</b> · ${latency} ms · tier 2a` }]);
    if (!approved) setBlockedCount((c) => c + 1);
    setP99(0.20 + Math.random() * 0.09);
    setVerdict({ approved, reason, latency });
    setBusy(false);
  };

  const toneVar = (v: boolean) => (v ? 'var(--ok)' : 'var(--bad)');

  return (
    <main className="min-h-screen relative" style={{ background: 'transparent' }}>
      {/* ambient background */}
      <div className="ap2-bg" />
      <div className="ap2-glow ap2-glow-a" />
      <div className="ap2-glow ap2-glow-b" />

      <div className="max-w-[1120px] mx-auto px-5 sm:px-6 py-6 relative">

        {/* ══ header ══ */}
        <header className="reveal flex items-center justify-between gap-4 pb-5" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center gap-3.5">
            {/* rotating-ring logo */}
            <div className="relative w-[40px] h-[40px] grid place-items-center">
              <div className="logo-ring absolute inset-0 rounded-[11px]" />
              <div className="logo-ring-inner absolute inset-[2px] rounded-[9px] grid place-items-center" style={{ color: 'var(--accent)' }}>
                <ShieldCheck size={19} strokeWidth={1.8} />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <span className="text-[18px] font-semibold tracking-tight" style={{ textShadow: '0 0 24px rgba(122,162,247,.35)' }}>AP2-GUARD</span>
                <span className="font-mono text-[10px] px-[7px] py-[2px] rounded-md" style={{ border: '1px solid var(--line-glow)', color: 'var(--accent)', background: 'var(--accent-dim)' }}>v1.0 · PROD</span>
              </div>
              <div className="text-[12px] mt-[1px]" style={{ color: 'var(--text-3)' }}>Semantic payment firewall · delegated authorization proxy</div>
            </div>
          </div>
          <div className="flex items-center gap-5">
            <div className="hidden md:flex items-center gap-2 text-[11px] font-mono px-2.5 py-1.5 rounded-md" style={{ border: '1px solid var(--line)', color: 'var(--text-3)', background: 'var(--panel)' }}>
              <Radio size={12} className="pulse-dot" style={{ color: 'var(--ok)' }} />
              STRIPE WEBHOOK · LIVE
            </div>
            <div className="text-right">
              <div className="num text-[16px] font-semibold" style={{ color: 'var(--text)' }}>{p99.toFixed(2)} ms</div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-4)' }}>p99 LATENCY</div>
            </div>
          </div>
        </header>

        {/* ══ ticker ══ */}
        <div className="reveal d1 overflow-hidden py-[6px] mb-1" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div className="ticker-track font-mono text-[10px]" style={{ color: 'var(--text-4)' }}>
            {[0, 1].map((k) => (
              <span key={k} className="flex">
                {['DETERMINISTIC AST ENGINE — ZERO AI IN REQUEST PATH', 'GOOGLE AP2 · TAP PROTOCOL', 'WYSIWYS PASSKEY-BOUND INTENTS', 'STRIPE SYNCHRONOUS AUTH < 2.0S', 'TIER 2A ENFORCEMENT', 'RFC 8785 CANONICAL JSON'].map((t, ix) => (
                  <span key={ix} className="mx-6 flex items-center gap-2">
                    <Zap size={9} style={{ color: 'var(--accent)' }} />{t}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>

        {/* ══ metric strip ══ */}
        <section className="reveal d1 grid grid-cols-2 md:grid-cols-4 gap-3 my-4">
          {[
            { label: 'ENGINE ARCHITECTURE', value: 'AST Engine', sub: 'deterministic · zero AI', icon: <Crosshair size={14} />, accent: 'var(--accent)' },
            { label: 'ATTACK RECALL', value: '100.0%', sub: '4 held-out taxonomies', icon: <Activity size={14} />, accent: 'var(--ok)' },
            { label: 'PROTOCOL', value: 'AP2 · TAP', sub: 'wysiwys · passkey-bound', icon: <Lock size={14} />, accent: 'var(--violet)' },
            { label: 'THREATS BLOCKED', value: String(blockedCount), sub: 'this session', icon: <ShieldAlert size={14} />, accent: 'var(--bad)' },
          ].map((m) => (
            <div key={m.label} className="card-lift hud-frame rounded-[10px] px-4 py-3" style={{ background: 'var(--glass)', border: '1px solid var(--line)', backdropFilter: 'blur(8px)' }}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono tracking-wide" style={{ color: 'var(--text-3)' }}>{m.label}</span>
                <span style={{ color: m.accent }}>{m.icon}</span>
              </div>
              <div className="num text-[17px] font-semibold mt-1">{m.value}</div>
              <div className="text-[11px] font-mono" style={{ color: 'var(--text-4)' }}>{m.sub}</div>
            </div>
          ))}
        </section>

        {/* ══ main grid ══ */}
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">

          {/* ── scenario rail ── */}
          <div className="reveal d2 flex flex-col gap-2">
            <div className="flex items-center justify-between px-[2px] pb-[4px]">
              <span className="text-[11px] font-mono tracking-wide" style={{ color: 'var(--text-3)' }}>// TEST SCENARIOS</span>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-4)' }}>04 loaded</span>
            </div>
            {SCENARIOS.map((sc, ix) => {
              const active = sel === ix;
              return (
                <button
                  key={sc.id}
                  onClick={() => loadScenario(ix)}
                  className="card-lift text-left rounded-[10px] p-3 relative overflow-hidden"
                  style={{
                    border: `1px solid ${active ? (sc.attack ? 'rgba(251,113,133,0.55)' : 'rgba(122,162,247,0.55)') : 'var(--line)'}`,
                    background: active ? (sc.attack ? 'rgba(251,113,133,0.05)' : 'var(--accent-dim)') : 'var(--glass)',
                    cursor: busy ? 'default' : 'pointer',
                    boxShadow: active ? `0 0 24px -8px ${sc.attack ? 'rgba(251,113,133,.4)' : 'rgba(122,162,247,.4)'}` : 'none',
                  }}
                >
                  {active && <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: sc.attack ? 'var(--bad)' : 'var(--accent)' }} />}
                  <div className="flex items-center justify-between">
                    <span className="font-mono num text-[11px]" style={{ color: 'var(--text-4)' }}>{sc.n}</span>
                    <div className="flex items-center gap-2">
                      <ThreatMeter level={sc.threat} />
                      <span
                        className="text-[10px] font-mono px-[6px] py-[1px] rounded"
                        style={{
                          color: sc.attack ? 'var(--bad)' : 'var(--ok)',
                          border: `1px solid ${sc.attack ? 'rgba(251,113,133,0.4)' : 'rgba(52,211,153,0.4)'}`,
                          background: sc.attack ? 'var(--bad-dim)' : 'var(--ok-dim)',
                        }}
                      >
                        {sc.attack ? 'ATTACK' : 'CLEAN'}
                      </span>
                    </div>
                  </div>
                  <div className="text-[13.5px] font-medium mt-1.5">{sc.name}</div>
                  <div className="font-mono text-[10.5px] mt-[3px]" style={{ color: sc.attack ? 'var(--bad)' : 'var(--text-4)' }}>{sc.tag}</div>
                  <div className="text-[11.5px] mt-[4px] leading-[1.5]" style={{ color: 'var(--text-3)' }}>{sc.desc}</div>
                </button>
              );
            })}

            <button
              onClick={run}
              disabled={busy}
              className="btn-run mt-1.5 h-[42px] rounded-[10px] text-[14px] font-semibold flex items-center justify-center gap-2 transition-all duration-200"
              style={{
                background: busy ? 'var(--panel)' : 'linear-gradient(135deg, #7aa2f7 0%, #5a7ff0 55%, #c792ea 130%)',
                color: '#06070b',
                border: '1px solid rgba(122,162,247,0.5)',
                opacity: busy ? 0.6 : 1,
                cursor: busy ? 'default' : 'pointer',
                boxShadow: busy ? 'none' : '0 4px 24px -6px rgba(122,162,247,.5)',
              }}
            >
              {busy ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
              {busy ? 'Evaluating invariants…' : 'Run authorization check'}
            </button>
            <div className="flex items-center justify-between font-mono text-[10px] px-[2px]">
              <span style={{ color: 'var(--text-4)' }}>deterministic · tier 2a ast diff</span>
              <span className="flex items-center gap-1" style={{ color: 'var(--text-4)' }}>
                <kbd className="px-[5px] py-[1px] rounded border" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>R</kbd> run
              </span>
            </div>
          </div>

          {/* ── inspector ── */}
          <div className="reveal d3 rounded-[12px] p-4 relative overflow-hidden" style={{ background: 'var(--glass)', border: '1px solid var(--line)', backdropFilter: 'blur(10px)' }}>
            {busy && <div className="scanline" />}
            <div className="flex items-center justify-between pb-3 mb-3" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="text-[13.5px] font-semibold flex items-center gap-2">
                <FileJson2 size={14} style={{ color: 'var(--accent)' }} />
                WYSIWYS · intent vs cart
              </div>
              <div className="flex items-center gap-3">
                <PipelineViz stage={stage} />
                <span className="font-mono text-[10px] hidden sm:inline" style={{ color: 'var(--text-4)' }}>RFC 8785</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* intent pane */}
              <div className="hud-frame rounded-[9px] p-3 relative" style={{ border: '1px solid var(--line)', background: 'var(--panel-2)' }}>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono" style={{ color: 'var(--text-3)' }}>
                    <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)' }} />
                    USER-SIGNED INTENTSPEC
                  </div>
                  <Lock size={11} style={{ color: 'var(--text-4)' }} />
                </div>
                <IntentPane s={s} />
              </div>
              {/* cart pane */}
              <div className="hud-frame rounded-[9px] p-3 relative" style={{ border: '1px solid var(--line)', background: 'var(--panel-2)' }}>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono" style={{ color: 'var(--text-3)' }}>
                    <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'var(--warn)', boxShadow: '0 0 8px var(--warn)' }} />
                    MERCHANT CARTMANDATE
                  </div>
                  <Unlock size={11} style={{ color: 'var(--text-4)' }} />
                </div>
                <CartPane s={s} />
              </div>
            </div>

            {/* rule ledger */}
            <div className="mt-3 pt-2.5 flex flex-col" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="flex items-center gap-1.5 text-[10px] font-mono pb-1.5" style={{ color: 'var(--text-3)' }}>
                <ListChecks size={12} /> // INVARIANT LEDGER
              </div>
              {rules.map((r, ix) => {
                const st = ruleState[ix] ?? 'pending';
                return (
                  <div
                    key={r.key}
                    className="flex items-center gap-2.5 py-[6px] px-[6px] rounded-[5px] transition-colors duration-300"
                    style={{
                      borderBottom: '1px solid var(--line-soft)',
                      background: st === 'fail' ? 'rgba(251,113,133,0.05)' : st === 'pass' ? 'rgba(52,211,153,0.03)' : 'transparent',
                    }}
                  >
                    <span className="font-mono num text-[10px] w-[16px]" style={{ color: 'var(--text-4)' }}>
                      {String(ix + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[11.5px] w-[190px] shrink-0" style={{ color: 'var(--text)' }}>{r.name}</span>
                    <span className="font-mono num text-[11px] flex-1 truncate hidden sm:block" style={{ color: 'var(--text-3)' }}>{r.expr}</span>
                    <span
                      className={`font-mono text-[10px] px-[8px] py-[2px] rounded-full transition-all duration-300 ${
                        st === 'pass' ? 'pill-pass' : st === 'fail' ? 'pill-fail' : ''
                      }`}
                      style={st === 'pending' ? { color: 'var(--text-4)', border: '1px solid var(--line)' } : {}}
                    >
                      {st === 'pending' ? '···' : st.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ══ verdict terminal ══ */}
        <div className="reveal d4 rounded-[12px] p-4 mt-4 relative" style={{ background: 'var(--glass)', border: '1px solid var(--line)', backdropFilter: 'blur(10px)' }}>
          <div className="flex items-center justify-between pb-2.5 mb-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="text-[13.5px] font-semibold flex items-center gap-2">
              <Terminal size={14} style={{ color: 'var(--accent)' }} /> Inspection log
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex gap-[5px]">
                <span className="w-[9px] h-[9px] rounded-full" style={{ background: 'rgba(251,113,133,.6)' }} />
                <span className="w-[9px] h-[9px] rounded-full" style={{ background: 'rgba(251,191,36,.6)' }} />
                <span className="w-[9px] h-[9px] rounded-full" style={{ background: 'rgba(52,211,153,.6)' }} />
              </div>
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-4)' }}>{reqId}</span>
            </div>
          </div>

          <div ref={logRef} className="font-mono text-[12px] leading-[2] min-h-[76px] max-h-[180px] overflow-y-auto pr-2">
            {log.length === 0 ? (
              <div>
                <span style={{ color: 'var(--text-4)' }}>› awaiting evaluation</span>
                <span className="caret" style={{ color: 'var(--accent)' }}> ▌</span>
              </div>
            ) : (
              log.map((l, ix) => (
                <div key={ix}>
                  <span style={{ color: 'var(--text-4)' }}>{l.ts}</span>{' '}
                  <span
                    style={{
                      color: l.tone === 'ok' ? 'var(--ok)' : l.tone === 'bad' ? 'var(--bad)' : l.tone === 'warn' ? 'var(--warn)' : 'var(--text-3)',
                    }}
                    dangerouslySetInnerHTML={{ __html: l.html }}
                  />
                </div>
              ))
            )}
          </div>

          {verdict && (
            <div
              className={`verdict-in relative flex items-center gap-3.5 px-4 py-3.5 rounded-[10px] mt-3 overflow-hidden ${verdict.approved ? '' : 'glitch'}`}
              style={{
                border: `1px solid ${verdict.approved ? 'rgba(52,211,153,0.5)' : 'rgba(251,113,133,0.5)'}`,
                background: verdict.approved ? 'rgba(52,211,153,0.06)' : 'rgba(251,113,133,0.06)',
                boxShadow: verdict.approved
                  ? '0 0 40px -10px rgba(52,211,153,.35), inset 0 0 30px -18px rgba(52,211,153,.3)'
                  : '0 0 40px -10px rgba(251,113,133,.4), inset 0 0 30px -18px rgba(251,113,133,.3)',
              }}
            >
              {!verdict.approved && (
                <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'var(--bad)', boxShadow: '0 0 12px var(--bad)' }} />
              )}
              {verdict.approved
                ? <Check size={20} style={{ color: toneVar(true) }} className="shrink-0" />
                : <AlertTriangle size={20} style={{ color: toneVar(false) }} className="shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="text-[14.5px] font-semibold" style={{ color: toneVar(verdict.approved) }}>
                  {verdict.approved ? 'Authorization granted' : 'Authorization blocked'}
                </div>
                <div className="font-mono text-[11.5px] mt-[2px]" style={{ color: 'var(--text-2)' }}>
                  reason <span className="font-semibold" style={{ color: toneVar(verdict.approved) }}>{verdict.reason}</span>
                  {' '}· {verdict.latency} ms · deterministic, zero AI
                </div>
              </div>
              <div className="relative shrink-0 mr-2">
                <span
                  className={`stamp-in inline-block font-mono text-[12px] font-bold px-2.5 py-1 rounded border-2 ${verdict.approved ? '' : ''}`}
                  style={{
                    color: toneVar(verdict.approved),
                    borderColor: toneVar(verdict.approved),
                    letterSpacing: '0.08em',
                    textShadow: `0 0 12px ${verdict.approved ? 'rgba(52,211,153,.6)' : 'rgba(251,113,133,.6)'}`,
                  }}
                >
                  {verdict.approved ? '200 OK' : '402 BLOCKED'}
                </span>
              </div>
              <ArrowRight size={15} className="shrink-0" style={{ color: 'var(--text-4)' }} />
            </div>
          )}
        </div>

        {/* footer */}
        <footer className="reveal d5 mt-6 pb-4 flex items-center justify-between font-mono text-[10px]" style={{ color: 'var(--text-4)' }}>
          <span>AP2-GUARD © 2026 · TIER 2A ENFORCEMENT LAYER</span>
          <span className="flex items-center gap-1.5">
            <span className="w-[5px] h-[5px] rounded-full pulse-dot" style={{ background: 'var(--ok)' }} />
            ALL SYSTEMS NOMINAL
          </span>
        </footer>
      </div>
    </main>
  );
}