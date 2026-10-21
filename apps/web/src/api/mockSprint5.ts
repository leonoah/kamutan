import {
  ApiError,
  GREEN_THRESHOLD_DEFAULT,
  GREEN_THRESHOLD_MAX,
  GREEN_THRESHOLD_MIN,
  SHARE_LINK_MAX_DAYS,
  type ActorRef,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type AuditVerifyResult,
  type BoqLine,
  type BoqLinesResponse,
  type BoqSheetEvidence,
  type Correction,
  type CreateShareLinkRequest,
  type CreateShareLinkResponse,
  type DetectionsArtifact,
  type ExportDoc,
  type LineHistoryItem,
  type LinksArtifact,
  type MarkedPdfExportRequest,
  type OffboardingExport,
  type OffboardResponse,
  type OrgSettings,
  type OrgStatus,
  type PatchBoqLineRequest,
  type PatchOrgSettingsRequest,
  type Project,
  type ProjectBoqState,
  type PublicShareBoq,
  type PublicShareClient,
  type PublicShareMeta,
  type PublicShareOverlay,
  type Role,
  type RoomsArtifact,
  type ShareLink,
  type SheetRow,
} from "./types";

/**
 * Sprint 5 mock services (stand-in for the API agent's endpoints): append-only hash-chained audit log + line
 * history, marked-PDF export jobs (resolve to a small generated PDF), share links (token shown once, expiry,
 * revoke, 404 / 410), the public read-only share API, org settings and offboarding.
 */
export interface Sprint5Deps {
  projects: () => Map<string, Project>;
  rows: (projectId: string) => SheetRow[];
  boq: {
    listLines(projectId: string): BoqLinesResponse;
    state(projectId: string): ProjectBoqState | null;
    evidence(projectId: string, lineId: string): { items: { detectionId: string; sheetId: string }[] };
    sheetEvidence(projectId: string, sheetId: string, versionId: string): BoqSheetEvidence;
    links(projectId: string, sheetId: string): LinksArtifact | null;
  };
  artifacts: (row: SheetRow) => Promise<{ detections: DetectionsArtifact | null; rooms: RoomsArtifact | null }>;
  corrections: (projectId: string) => Correction[];
  orgs: () => { id: string; name: string; role: Role }[];
  role: () => Role;
  emit: () => void;
  tickMs: number;
  devBase: string;
  /** Seed demo links on p-noah (`/s/demo-noah`, `/s/demo-expired`, `/s/demo-revoked`). Default true. */
  seedLinks?: boolean;
  /** Tests: start with a broken audit chain. */
  auditBroken?: boolean;
}

export const MOCK_ACTOR: ActorRef = { uid: "mock-user", displayName: "דנה כהן" };
const DAY = 86_400_000;

/* ---------- tiny deterministic hash (mock chain only — the API uses SHA-256) ---------- */
function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(4);
}

/** Minimal valid one-page PDF (xref offsets computed), Latin text only. */
export function mockPdfBytes(title: string, pages = 1): Uint8Array {
  const safe = title.replace(/[^\x20-\x7e]/g, "?").replace(/[()\\]/g, "");
  const n = Math.max(1, Math.min(pages, 20));
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < n; i++) {
    const text = `BT /F1 18 Tf 60 760 Td (${safe} - page ${i + 1}/${n}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Empty but valid ZIP (end-of-central-directory record only). */
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

function blobUrl(bytes: Uint8Array, type: string): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
    try {
      return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
    } catch {
      /* fall through */
    }
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:${type};base64,${btoa(bin)}`;
}

function randomToken(): string {
  const b = new Uint8Array(32);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const fmtDateIL = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
};

interface StoredLink extends ShareLink {
  projectId: string;
  token: string;
}

export function createSprint5Mock(deps: Sprint5Deps) {
  const audit: AuditEvent[] = []; // oldest first
  const settings = new Map<string, OrgSettings>();
  const orgState = new Map<string, { status: OrgStatus; deleteAfter: string | null; slug: string }>();
  const exports = new Map<string, ExportDoc & { projectId: string; readyAt: number; pages: number }>();
  const offExports = new Map<string, OffboardingExport & { orgId: string; readyAt: number }>();
  const links = new Map<string, StoredLink>();
  let seq = 0;
  const id = (p: string) => `${p}${(++seq).toString(36)}${Date.now().toString(36).slice(-4)}`;
  const now = () => new Date().toISOString();

  const orgOf = (orgId: string) => {
    let st = orgState.get(orgId);
    if (!st) {
      st = { status: "active", deleteAfter: null, slug: orgId === "org-demo" ? "studio-noah" : orgId };
      orgState.set(orgId, st);
    }
    return st;
  };
  const settingsOf = (orgId: string): OrgSettings => {
    let s = settings.get(orgId);
    if (!s) {
      s = { llmEnabled: false, blockExportOnRed: false, greenThreshold: GREEN_THRESHOLD_DEFAULT, trainingOptIn: false, llmMonthlyBudgetUsd: 30, vatRate: 0.18, autoRebuild: true };
      settings.set(orgId, s);
    }
    return s;
  };
  const projectOrg = (projectId: string) => deps.projects().get(projectId)?.orgId ?? "org-demo";
  const assertActive = (orgId: string) => {
    if (orgOf(orgId).status !== "active") throw new ApiError(403, "org_offboarding", "Organisation is being offboarded");
  };
  const requireRole = (allowed: Role[]) => {
    if (!allowed.includes(deps.role())) throw new ApiError(403, "forbidden", "insufficient role");
  };

  function append(e: Omit<AuditEvent, "id" | "hash" | "prevHash" | "at"> & { at?: string }, orgId = "org-demo"): AuditEvent {
    const prevHash = audit.length ? audit[audit.length - 1]!.hash ?? null : null;
    const row: AuditEvent = { id: id("a"), at: e.at ?? now(), ...e, meta: { ...(e.meta ?? {}), orgId }, prevHash };
    row.hash = fnv(JSON.stringify({ ...row, hash: undefined }));
    audit.push(row);
    return row;
  }

  // Seed an org history (≥ 2 pages) so the audit screen and its paging are demoable.
  {
    const t0 = Date.parse("2026-10-11T08:00:00.000Z");
    const seedActs: [string, string, string | null][] = [
      ["login", "users", "mock-user"],
      ["create", "projects", "p-noah"],
      ["upload", "sheetSets", "s-noah-1"],
      ["create", "boqBuilds", "b-seed"],
      ["create", "members", "uid-lea"],
      ["update", "members", "uid-lea"],
      ["create", "exports", "x-seed"],
    ];
    for (let i = 0; i < 42; i++) {
      const [action, entity, entityId] = seedActs[i % seedActs.length]!;
      append({ at: new Date(t0 + i * 37 * 60_000).toISOString(), actor: i % 3 === 0 ? { uid: "uid-lea", displayName: "לאה לוי" } : MOCK_ACTOR, action, entity, entityId, projectId: entity === "members" || entity === "users" ? null : "p-noah" });
    }
    if (deps.auditBroken && audit[20]) audit[20] = { ...audit[20], after: { tampered: true } };
  }

  /* ---------- share links ---------- */
  function publicLink(l: StoredLink): ShareLink {
    const { projectId: _p, token: _t, ...rest } = l;
    return { ...rest, versionLock: [...rest.versionLock] };
  }
  function makeLink(projectId: string, req: CreateShareLinkRequest, token: string, createdAt = now()): StoredLink {
    const rows = deps.rows(projectId).filter((r) => r.version?.status === "ready");
    return {
      id: id("sl"),
      projectId,
      token,
      label: req.label.trim(),
      recipient: req.recipient?.trim() || null,
      versionLock: rows.map((r) => `${r.sheet.id}__${r.version!.id}`),
      expiresAt: new Date(Date.parse(createdAt) + req.days * DAY).toISOString(),
      revokedAt: null,
      hideTitleBlock: req.hideTitleBlock ?? true,
      allowPdfDownload: req.allowPdfDownload ?? false,
      viewCount: 0,
      lastViewedAt: null,
      createdBy: MOCK_ACTOR.uid,
      createdAt,
    };
  }
  if (deps.seedLinks ?? true) {
    const t = Date.now();
    const base = new Date(t - 3 * DAY).toISOString();
    const ok = makeLink("p-noah", { days: 14, label: "קבלן חשמל — הצעת מחיר", recipient: "יוסי אלקטריק", allowPdfDownload: true }, "demo-noah", base);
    ok.viewCount = 3;
    ok.lastViewedAt = new Date(t - 5 * 3_600_000).toISOString();
    const expired = makeLink("p-noah", { days: 7, label: "פיקוח — גרסה ראשונה", recipient: null }, "demo-expired", new Date(t - 20 * DAY).toISOString());
    expired.viewCount = 1;
    const revoked = makeLink("p-noah", { days: 30, label: "אינסטלטור", recipient: "משה צנרת" }, "demo-revoked", new Date(t - 2 * DAY).toISOString());
    revoked.revokedAt = new Date(t - DAY).toISOString();
    for (const l of [ok, expired, revoked]) links.set(l.id, l);
  }

  function resolveToken(token: string): StoredLink {
    const l = [...links.values()].find((x) => x.token === token);
    // Same body for unknown / revoked / expired except the status (brief §4); the code tells the UI which screen.
    if (!l) throw new ApiError(404, "share_not_found", "Link is not active");
    if (l.revokedAt) throw new ApiError(410, "share_revoked", "Link is not active");
    if (Date.parse(l.expiresAt) <= Date.now()) throw new ApiError(410, "share_expired", "Link is not active");
    if (orgOf(projectOrg(l.projectId)).status !== "active") throw new ApiError(410, "share_revoked", "Link is not active");
    return l;
  }
  const watermarkOf = (l: StoredLink) => `שותף עם ${l.recipient || l.label} • ${fmtDateIL(now())} • ${l.id.slice(-6)}`;

  async function waitForBuild(projectId: string) {
    for (let i = 0; i < 200; i++) {
      const lines = deps.boq.listLines(projectId);
      if (lines.items.length) return lines;
      await new Promise((r) => setTimeout(r, Math.max(20, deps.tickMs)));
    }
    return deps.boq.listLines(projectId);
  }

  const publicShare: PublicShareClient = {
    async getMeta(token): Promise<PublicShareMeta> {
      const l = resolveToken(token);
      l.viewCount += 1;
      l.lastViewedAt = now();
      append({ actor: null, action: "view", actorKind: "share_link", entity: "shareLinks", entityId: l.id, projectId: l.projectId, meta: { ipPrefix: "203.0.113.0/24", userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : "test" } }, projectOrg(l.projectId));
      const p = deps.projects().get(l.projectId);
      const org = deps.orgs().find((o) => o.id === p?.orgId);
      const rows = deps.rows(l.projectId).filter((r) => r.version?.status === "ready" && r.version.artifacts?.tiles);
      const dates = rows.map((r) => r.version!.updatedAt ?? r.version!.createdAt).sort();
      return {
        linkId: l.id,
        projectName: p?.name ?? "",
        orgName: org?.name ?? null,
        label: l.label,
        expiresAt: l.expiresAt,
        versionDate: dates[dates.length - 1] ?? null,
        hideTitleBlock: l.hideTitleBlock,
        allowPdfDownload: l.allowPdfDownload,
        showConfidence: true,
        watermark: watermarkOf(l),
        sheets: rows.map((r) => {
          const t = r.version!.artifacts!.tiles!;
          return {
            id: r.sheet.id,
            versionId: r.version!.id,
            title: r.sheet.title ?? null,
            discipline: r.sheet.discipline ?? null,
            floors: r.sheet.floors ?? [],
            page: r.version!.page ? { widthMm: r.version!.page.widthMm, heightMm: r.version!.page.heightMm } : { widthMm: (t.widthPx / t.dpi) * 25.4, heightMm: (t.heightPx / t.dpi) * 25.4 },
            tiles: { tileSize: t.tileSize, dpi: t.dpi, levels: t.levels, widthPx: t.widthPx, heightPx: t.heightPx },
          };
        }),
      };
    },
    async getBoq(token): Promise<PublicShareBoq> {
      const l = resolveToken(token);
      const res = await waitForBuild(l.projectId);
      return {
        lines: res.items.map((x: BoqLine) => ({
          id: x.id,
          chapter: x.chapter,
          chapterTitle: x.chapterTitle ?? null,
          code: x.code,
          description: x.description,
          unit: x.unit,
          qty: x.qtyOverride ?? x.qty,
          level: x.level,
          status: x.status,
          byFloor: { ...x.byFloor },
          ...(x.order !== undefined ? { order: x.order } : {}),
        })),
        chapters: (res.chapters ?? []).map((c) => ({ code: c.code, title: c.title })),
      };
    },
    async getOverlay(token, sheetId): Promise<PublicShareOverlay> {
      const l = resolveToken(token);
      const row = deps.rows(l.projectId).find((r) => r.sheet.id === sheetId && r.version?.status === "ready");
      if (!row?.version) throw new ApiError(404, "share_not_found", "Link is not active");
      await waitForBuild(l.projectId); // the evidence index belongs to the build
      const art = await deps.artifacts(row);
      const ev = deps.boq.sheetEvidence(l.projectId, sheetId, row.version.id);
      const evidence: Record<string, string[]> = {};
      for (const [det, lineIds] of Object.entries(ev.detections)) for (const li of lineIds) (evidence[li] ??= []).push(det);
      return {
        sheetId,
        versionId: row.version.id,
        detections: (art.detections?.detections ?? []).map((d) => ({ id: d.id, class: d.class, centerMm: d.centerMm, bboxMm: d.bboxMm, level: d.level, lifecycle: d.lifecycle, floor: d.floor, roomId: d.roomId })),
        rooms: (art.rooms?.rooms ?? []).map((r) => ({ id: r.id, name: r.name, floor: r.floor, polygonMm: r.polygonMm, areaM2: r.areaM2 })),
        linkGroups: (deps.boq.links(l.projectId, sheetId)?.groups ?? []).map((g) => ({ id: g.id, switchIds: g.switchIds, luminaireIds: g.luminaireIds, pointIds: g.pointIds, level: g.level })),
        evidence,
      };
    },
    tileUrl(token, sheetId, z, x, y) {
      const l = [...links.values()].find((v) => v.token === token);
      const row = l ? deps.rows(l.projectId).find((r) => r.sheet.id === sheetId) : undefined;
      const prefix = row?.version?.artifacts?.tiles?.prefix;
      return prefix ? `${deps.devBase}/${prefix}/${z}/${x}_${y}.webp` : "";
    },
    pdfUrl(token) {
      const l = resolveToken(token);
      if (!l.allowPdfDownload) throw new ApiError(403, "pdf_not_allowed", "PDF download is not allowed");
      return blobUrl(mockPdfBytes(`Kamutan shared marked PDF ${l.id}`, 2), "application/pdf");
    },
  };

  /* ---------- export jobs ---------- */
  function progressOf(readyAt: number, started: number) {
    const total = Math.max(1, readyAt - started);
    return Math.min(100, Math.round(((Date.now() - started) / total) * 100));
  }

  return {
    publicShare,
    audit: () => audit,
    orgPatch(orgId: string) {
      const st = orgOf(orgId);
      return { settings: { ...settingsOf(orgId) }, slug: st.slug, status: st.status, deleteAfter: st.deleteAfter };
    },
    blockExportOnRed: (orgId = "org-demo") => settingsOf(orgId).blockExportOnRed,
    setBlockExportOnRed(orgId: string, v: boolean) {
      settingsOf(orgId).blockExportOnRed = v;
    },
    assertProjectActive(projectId: string) {
      assertActive(projectOrg(projectId));
    },

    /** Called by the mock's patchLine wrapper with the line before / after. */
    recordLinePatch(projectId: string, before: BoqLine, after: BoqLine, req: PatchBoqLineRequest) {
      const base = { actor: MOCK_ACTOR, entity: "boqLines", entityId: before.id, projectId };
      const org = projectOrg(projectId);
      if (req.qtyOverride !== undefined && (before.qtyOverride ?? null) !== (after.qtyOverride ?? null))
        append({ ...base, action: "qtyOverride", before: { qty: before.qtyOverride ?? before.qty, override: before.qtyOverride ?? null }, after: { qty: after.qtyOverride ?? after.qty, override: after.qtyOverride ?? null }, meta: { kind: "qtyOverride", reason: req.reason?.trim() || null } }, org);
      if (before.status !== after.status)
        append({ ...base, action: "status", before: { status: before.status }, after: { status: after.status }, meta: { kind: "status", reason: req.qtyOverride !== undefined && !req.status ? "override_reopened" : null } }, org);
      if (req.note !== undefined && (before.note ?? null) !== (after.note ?? null))
        append({ ...base, action: "note", before: { note: before.note ?? null }, after: { note: after.note ?? null }, meta: { kind: "note" } }, org);
    },
    recordCorrection(projectId: string, c: { kind: string; class: string | null; detectionId: string | null }) {
      append({ actor: MOCK_ACTOR, action: "create", entity: "corrections", entityId: c.detectionId, projectId, after: { kind: c.kind, class: c.class } }, projectOrg(projectId));
    },

    lineHistory(projectId: string, lineId: string): { items: LineHistoryItem[] } {
      const lines = deps.boq.listLines(projectId).items;
      const line = lines.find((l) => l.id === lineId);
      if (!line) throw new ApiError(404, "not_found", "Line not found");
      const items: LineHistoryItem[] = audit
        .filter((e) => e.entity === "boqLines" && e.entityId === lineId)
        .map((e) => ({
          at: e.at,
          by: e.actor,
          action: ((e.meta?.kind as LineHistoryItem["action"]) ?? "status"),
          before: e.before ?? null,
          after: e.after ?? null,
          reason: (e.meta?.reason as string | null) ?? null,
        }));
      const detIds = new Set(deps.boq.evidence(projectId, lineId).items.map((x) => x.detectionId));
      for (const c of deps.corrections(projectId))
        if (c.detectionId && detIds.has(c.detectionId))
          items.push({ at: c.at, by: { uid: c.by, displayName: c.by === MOCK_ACTOR.uid ? MOCK_ACTOR.displayName : null }, action: "correction", before: null, after: { kind: c.kind, class: c.class, itemCode: c.itemCode }, reason: c.reason });
      if (line.computedAt) items.push({ at: line.computedAt, by: null, action: "rebuild", before: null, after: { qty: line.qty }, reason: null });
      items.sort((a, b) => b.at.localeCompare(a.at));
      return { items };
    },

    listAudit(orgId: string, q: AuditQuery = {}): AuditPage {
      requireRole(["admin"]);
      const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
      const all = audit
        .filter((e) => (e.meta?.orgId ?? "org-demo") === orgId)
        .filter((e) => !q.entity || e.entity === q.entity)
        .filter((e) => !q.action || e.action === q.action)
        .slice()
        .reverse();
      const start = q.cursor ? Math.max(0, all.findIndex((e) => e.id === q.cursor) + 1) : 0;
      const items = all.slice(start, start + limit);
      return { items: items.map((e) => ({ ...e })), nextCursor: start + limit < all.length ? items[items.length - 1]!.id : null };
    },
    verifyAudit(orgId: string): AuditVerifyResult {
      requireRole(["admin"]);
      let prev: string | null = null;
      let checked = 0;
      for (const e of audit) {
        const expect = fnv(JSON.stringify({ ...e, hash: undefined }));
        if (e.prevHash !== prev || e.hash !== expect) return { ok: false, checked, brokenAt: e.id };
        prev = e.hash ?? null;
        if ((e.meta?.orgId ?? "org-demo") === orgId) checked++;
      }
      return { ok: true, checked, brokenAt: null };
    },

    exportMarkedPdf(projectId: string, req: MarkedPdfExportRequest): { exportId: string } {
      requireRole(["admin", "editor"]);
      assertActive(projectOrg(projectId));
      if (!deps.boq.state(projectId)?.latestBuildId) throw new ApiError(409, "boq_not_built", "Build the BOQ first");
      const ready = deps.rows(projectId).filter((r) => r.version?.status === "ready");
      if (req.sheetIds && req.sheetIds.some((s) => !ready.some((r) => r.sheet.id === s))) throw new ApiError(400, "validation_failed", "unknown sheet");
      if (req.sheetIds && req.sheetIds.length === 0) throw new ApiError(400, "validation_failed", "no sheets");
      const exportId = id("x");
      const started = Date.now();
      const pages = (req.sheetIds?.length ?? ready.length) * (req.floorSplit ? 2 : 1) + 1;
      exports.set(exportId, {
        id: exportId,
        projectId,
        kind: "marked_pdf",
        status: "queued",
        progress: 0,
        pageCount: null,
        createdBy: MOCK_ACTOR.uid,
        createdAt: new Date(started).toISOString(),
        error: null,
        url: null,
        filename: null,
        expiresAt: null,
        readyAt: started + deps.tickMs * 6,
        pages,
      });
      append({ actor: MOCK_ACTOR, action: "create", entity: "exports", entityId: exportId, projectId, after: { sheets: req.sheetIds?.length ?? "all", floorSplit: req.floorSplit, hideTitleBlock: req.hideTitleBlock } }, projectOrg(projectId));
      return { exportId };
    },
    getExport(projectId: string, exportId: string): ExportDoc {
      const x = exports.get(exportId);
      if (!x || x.projectId !== projectId) throw new ApiError(404, "not_found", "Export not found");
      const started = Date.parse(x.createdAt);
      if (x.status !== "succeeded") {
        const pct = progressOf(x.readyAt, started);
        if (pct >= 100) {
          Object.assign(x, { status: "succeeded", progress: 100, pageCount: x.pages, url: blobUrl(mockPdfBytes(`Kamutan marked PDF ${projectId}`, x.pages), "application/pdf"), filename: `marked-${projectId}.pdf`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        } else Object.assign(x, { status: pct > 0 ? "running" : "queued", progress: pct });
      }
      const { projectId: _p, readyAt: _r, pages: _n, ...doc } = x;
      return { ...doc };
    },

    createShareLink(projectId: string, req: CreateShareLinkRequest, origin: string): CreateShareLinkResponse {
      requireRole(["admin", "editor"]);
      assertActive(projectOrg(projectId));
      if (!Number.isInteger(req.days) || req.days < 1 || req.days > SHARE_LINK_MAX_DAYS) throw new ApiError(400, "validation_failed", "days must be 1..90");
      if (!req.label?.trim() || req.label.length > 120) throw new ApiError(400, "validation_failed", "label is required");
      const l = makeLink(projectId, req, randomToken());
      links.set(l.id, l);
      append({ actor: MOCK_ACTOR, action: "create", entity: "shareLinks", entityId: l.id, projectId, after: { days: req.days, label: l.label, recipient: l.recipient, hideTitleBlock: l.hideTitleBlock, allowPdfDownload: l.allowPdfDownload } }, projectOrg(projectId));
      deps.emit();
      return { link: publicLink(l), url: `${origin}/s/${l.token}` };
    },
    listShareLinks(projectId: string): ShareLink[] {
      return [...links.values()].filter((l) => l.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicLink);
    },
    revokeShareLink(projectId: string, linkId: string): ShareLink {
      requireRole(["admin", "editor"]);
      const l = links.get(linkId);
      if (!l || l.projectId !== projectId) throw new ApiError(404, "not_found", "Link not found");
      if (!l.revokedAt) {
        l.revokedAt = now();
        append({ actor: MOCK_ACTOR, action: "revoke", entity: "shareLinks", entityId: l.id, projectId }, projectOrg(projectId));
      }
      return publicLink(l);
    },

    patchOrgSettings(orgId: string, req: PatchOrgSettingsRequest): OrgSettings {
      requireRole(["admin"]);
      assertActive(orgId);
      const cur = settingsOf(orgId);
      const allowed = ["greenThreshold", "blockExportOnRed", "llmEnabled", "trainingOptIn"] as const;
      for (const k of Object.keys(req)) if (!(allowed as readonly string[]).includes(k)) throw new ApiError(400, "validation_failed", `unknown field ${k}`);
      if (req.greenThreshold !== undefined && !(req.greenThreshold >= GREEN_THRESHOLD_MIN && req.greenThreshold <= GREEN_THRESHOLD_MAX)) throw new ApiError(400, "validation_failed", "greenThreshold out of range");
      for (const k of allowed) {
        const v = req[k];
        if (v === undefined || v === cur[k]) continue;
        append({ actor: MOCK_ACTOR, action: "update_settings", entity: "orgs", entityId: orgId, before: { [k]: cur[k] }, after: { [k]: v } }, orgId);
        (cur as unknown as Record<string, unknown>)[k] = v;
      }
      deps.emit();
      return { ...cur };
    },

    startOffboardingExport(orgId: string): OffboardingExport {
      requireRole(["admin"]);
      const exportId = id("ox");
      const started = Date.now();
      const doc = { id: exportId, orgId, status: "queued" as const, progress: 0, url: null, expiresAt: null, error: null, createdAt: new Date(started).toISOString(), readyAt: started + deps.tickMs * 8 };
      offExports.set(exportId, doc);
      append({ actor: MOCK_ACTOR, action: "create", entity: "offboardingExports", entityId: orgId }, orgId);
      const { orgId: _o, readyAt: _r, ...out } = doc;
      return out;
    },
    getOffboardingExport(orgId: string, exportId: string): OffboardingExport {
      requireRole(["admin"]);
      const x = offExports.get(exportId);
      if (!x || x.orgId !== orgId) throw new ApiError(404, "not_found", "Export not found");
      if (x.status !== "succeeded") {
        const pct = progressOf(x.readyAt, Date.parse(x.createdAt));
        if (pct >= 100) Object.assign(x, { status: "succeeded", progress: 100, url: blobUrl(EMPTY_ZIP, "application/zip"), expiresAt: new Date(Date.now() + DAY).toISOString() });
        else Object.assign(x, { status: pct > 0 ? "running" : "queued", progress: pct });
      }
      const { orgId: _o, readyAt: _r, ...out } = x;
      return { ...out };
    },
    offboardOrg(orgId: string, confirm: string): OffboardResponse {
      requireRole(["admin"]);
      const st = orgOf(orgId);
      // contracts OffboardOrgRequest: the typed confirmation is the org NAME (exact after trim).
      const name = deps.orgs().find((o) => o.id === orgId)?.name ?? st.slug;
      if (confirm.trim() !== name) throw new ApiError(400, "confirmation_mismatch", "slug does not match");
      if (st.status !== "active") throw new ApiError(409, "already_offboarding", "already offboarding");
      st.status = "offboarding";
      st.deleteAfter = new Date(Date.now() + 30 * DAY).toISOString();
      let revoked = 0;
      for (const l of links.values())
        if (projectOrg(l.projectId) === orgId && !l.revokedAt) {
          l.revokedAt = now();
          revoked++;
        }
      append({ actor: MOCK_ACTOR, action: "offboard", entity: "orgs", entityId: orgId, after: { deleteAfter: st.deleteAfter, revokedShareLinks: revoked } }, orgId);
      deps.emit();
      return { status: st.status, deleteAfter: st.deleteAfter, revokedShareLinks: revoked };
    },
  };
}
