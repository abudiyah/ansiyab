import type { ActionLogEntry, Alert, Provenance } from '../domain/types.ts';
import { RULES, ruleDefaults, type AlertCandidate, type AlertContext, type AlertRule } from './rules.ts';

export interface RuleConfig {
  enabled: boolean;
  params: Record<string, number>;
  persistenceS: number;
  clearAfterS: number;
  /** فترة تهدئة بعد الإغلاق قبل السماح بتنبيه جديد بنفس المفتاح */
  cooldownS: number;
}

export const defaultRuleConfig = (r: AlertRule): RuleConfig => ({
  enabled: true,
  params: ruleDefaults(r),
  persistenceS: r.defaultPersistenceS,
  clearAfterS: r.defaultClearAfterS,
  cooldownS: 15 * 60,
});

export interface EngineState {
  alerts: Alert[];
  /** مفتاح ← أول وقت تحقق فيه الشرط (قبل تجاوز مدة الاستمرار) */
  pending: Record<string, string>;
  /** مفتاح ← أول وقت غاب فيه الشرط عن تنبيه مفتوح */
  absentSince: Record<string, string>;
}

export const emptyEngineState = (): EngineState => ({ alerts: [], pending: {}, absentSince: {} });

export interface RuleStatus {
  ruleId: string;
  titleAr: string;
  enabled: boolean;
  evaluable: boolean;
  reasonAr?: string;
  candidates: number;
}

let seq = 0;
const newId = (now: Date) => `al_${now.getTime().toString(36)}_${(seq++).toString(36)}`;

/**
 * محرك التنبيهات: دالة نقية تأخذ الحالة السابقة وتعيد الحالة الجديدة.
 * منع التذبذب يتم بثلاث آليات: مدة استمرار قبل الإطلاق، وعتبتا دخول/خروج (hold)،
 * ومدة غياب قبل الإغلاق التلقائي، ثم فترة تهدئة قبل إعادة الإطلاق.
 */
export function evaluateAlerts(
  prev: EngineState,
  ctx: AlertContext,
  config: Record<string, RuleConfig> = {},
  provenance: Provenance = 'live',
): { state: EngineState; statuses: RuleStatus[]; opened: Alert[]; resolved: Alert[] } {
  const now = ctx.now;
  const nowIso = now.toISOString();
  const state: EngineState = {
    alerts: prev.alerts.map((a) => ({ ...a, log: [...a.log] })),
    pending: { ...prev.pending },
    absentSince: { ...prev.absentSince },
  };
  const statuses: RuleStatus[] = [];
  const seen = new Map<string, AlertCandidate>();
  const cfgOf = (r: AlertRule) => config[r.id] ?? defaultRuleConfig(r);

  for (const rule of RULES) {
    const cfg = cfgOf(rule);
    const ev = rule.canEvaluate(ctx);
    let cands: AlertCandidate[] = [];
    if (cfg.enabled && ev.ok) cands = rule.evaluate(ctx, { ...ruleDefaults(rule), ...cfg.params });
    for (const c of cands) seen.set(c.dedupeKey, c);
    statuses.push({ ruleId: rule.id, titleAr: rule.titleAr, enabled: cfg.enabled, evaluable: ev.ok, reasonAr: ev.reasonAr, candidates: cands.length });
  }

  const opened: Alert[] = [];
  const resolved: Alert[] = [];
  const activeByKey = new Map(state.alerts.filter((a) => a.status !== 'resolved').map((a) => [a.dedupeKey, a]));

  for (const [key, c] of seen) {
    const rule = RULES.find((r) => r.id === c.ruleId)!;
    const cfg = cfgOf(rule);
    const existing = activeByKey.get(key);
    delete state.absentSince[key];
    if (existing) {
      existing.lastEvaluatedAt = nowIso;
      existing.severity = c.severity;
      existing.reasonAr = c.reasonAr;
      existing.evidence = c.evidence;
      existing.confidence = c.confidence;
      continue;
    }
    // «hold» بين عتبتي الخروج والدخول: يُبقي العدّ المعلّق قائمًا ولا يبدؤه
    if (c.level !== 'enter') continue;
    const lastResolved = state.alerts
      .filter((a) => a.dedupeKey === key && a.status === 'resolved')
      .map((a) => a.log.at(-1)?.at ?? a.lastEvaluatedAt)
      .sort()
      .at(-1);
    if (lastResolved && (now.getTime() - new Date(lastResolved).getTime()) / 1000 < cfg.cooldownS) continue;
    const since = state.pending[key] ?? nowIso;
    state.pending[key] = since;
    if ((now.getTime() - new Date(since).getTime()) / 1000 < cfg.persistenceS) continue;
    delete state.pending[key];
    const alert: Alert = {
      id: newId(now),
      ruleId: c.ruleId,
      dedupeKey: key,
      status: 'open',
      severity: c.severity,
      reasonAr: c.reasonAr,
      locationAr: c.locationAr,
      geometry: c.geometry,
      districtIds: c.districtIds,
      firstDetectedAt: since,
      lastEvaluatedAt: nowIso,
      sourceIds: c.sourceIds,
      confidence: c.confidence,
      suggestedActionAr: c.suggestedActionAr,
      evidence: c.evidence,
      log: [],
      provenance,
    };
    state.alerts.push(alert);
    opened.push(alert);
  }

  // شروط اختفت: الإغلاق التلقائي بعد مدة الغياب
  for (const a of state.alerts) {
    if (a.status === 'resolved' || seen.has(a.dedupeKey)) continue;
    const rule = RULES.find((r) => r.id === a.ruleId);
    const clearAfter = rule ? cfgOf(rule).clearAfterS : 0;
    const since = state.absentSince[a.dedupeKey] ?? nowIso;
    state.absentSince[a.dedupeKey] = since;
    if ((now.getTime() - new Date(since).getTime()) / 1000 >= clearAfter) {
      a.status = 'resolved';
      a.log.push({ at: nowIso, actor: 'system', action: 'auto_resolve', note: 'زال الشرط لمدة كافية' });
      delete state.absentSince[a.dedupeKey];
      resolved.push(a);
    }
  }
  // تنظيف المعلّقات التي لم تعد مرشحة
  for (const k of Object.keys(state.pending)) if (!seen.has(k)) delete state.pending[k];

  return { state, statuses, opened, resolved };
}

/** إجراء بشري على تنبيه (إقرار/ملاحظة/إغلاق) مع سجل */
export function applyAction(state: EngineState, alertId: string, entry: Omit<ActionLogEntry, 'at'>, at = new Date()): EngineState {
  return {
    ...state,
    alerts: state.alerts.map((a) => {
      if (a.id !== alertId) return a;
      const log = [...a.log, { ...entry, at: at.toISOString() }];
      const status = entry.action === 'acknowledge' ? 'acknowledged' : entry.action === 'resolve' ? 'resolved' : entry.action === 'reopen' ? 'open' : a.status;
      return { ...a, status, log };
    }),
  };
}
