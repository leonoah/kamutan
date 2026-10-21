import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldX } from "lucide-react";
import { useApi } from "@/api/client";
import type { AuditEvent } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Ltr } from "@/components/Ltr";
import { useOrgId } from "@/features/org/useCurrentOrg";
import { formatDateTime } from "@/lib/format";

const ENTITIES = ["boqLines", "shareLinks", "orgs", "exports", "offboardingExports", "corrections", "projects", "sheetSets", "sheets", "legendEntries", "roomSettings", "itemLibrary", "boqBuilds", "members", "users"] as const;
/** contracts audit actions are verbs (entity + action), e.g. shareLinks · view. */
const ACTIONS = ["create", "update", "update_settings", "status", "qtyOverride", "note", "confirm", "upload", "download", "read", "view", "revoke", "revoke_all", "revoke_sessions", "offboard", "deny", "login"] as const;
export const AUDIT_PAGE = 20;

const short = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  return Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${k}: ${typeof x === "object" && x !== null ? JSON.stringify(x) : String(x)}`)
    .join(", ");
};
/** One-line details: before → after (raw values; this screen is for admins / evidence). */
export function auditDetails(e: AuditEvent): string {
  const b = short(e.before);
  const a = short(e.after);
  if (b && a) return `${b} ← ${a}`;
  return a || b || short(e.meta && Object.fromEntries(Object.entries(e.meta).filter(([k]) => k !== "orgId")));
}
/** Action ids contain dots ("share.view"), so they are looked up in the object, not as i18next key paths. */
export const actionLabel = (t: TFunction, a: string): string => (t("audit.actions", { returnObjects: true }) as Record<string, string>)[a] ?? a;

/** S13 org audit log (SEC-35): newest first, filters by entity / action, cursor paging, hash-chain indicator. Admin only. */
export function AuditLogPage() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const ids = { e: useId(), a: useId() };
  const pages = useInfiniteQuery({
    queryKey: ["audit", orgId, entity, action],
    queryFn: ({ pageParam }) => api.listAudit(orgId, { cursor: pageParam, entity: entity || null, action: action || null, limit: AUDIT_PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (p) => p.nextCursor,
  });
  const verify = useQuery({ queryKey: ["audit-verify", orgId], queryFn: () => api.verifyAudit(orgId), staleTime: 60_000, retry: false });
  const rows = pages.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-4" data-audit>
      <p className="text-dense text-muted-foreground">{t("audit.subtitle")}</p>
      <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-dense" data-verify={verify.data ? (verify.data.ok ? "ok" : "broken") : verify.isError ? "error" : "checking"}>
        {verify.isLoading ? (
          <span className="text-muted-foreground">{t("audit.verifyChecking")}</span>
        ) : verify.isError ? (
          <span className="text-destructive">{t("audit.verifyError")}</span>
        ) : verify.data?.ok ? (
          <>
            <ShieldCheck className="size-4 text-conf-high" aria-hidden />
            <span className="text-foreground">{t("audit.verifyOk", { count: verify.data.checked })}</span>
          </>
        ) : (
          <>
            <ShieldX className="size-4 text-destructive" aria-hidden />
            <span className="font-medium text-destructive">
              {t("audit.verifyBroken", { id: "" })}
              <Ltr>{verify.data?.brokenAt ?? ""}</Ltr>
            </span>
          </>
        )}
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => void verify.refetch()} disabled={verify.isFetching}>
          {t("audit.verifyAgain")}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.e} className="text-meta text-muted-foreground">{t("audit.entity")}</label>
          <select id={ids.e} value={entity} onChange={(e) => setEntity(e.target.value)} className="h-9 rounded border border-input bg-surface px-2 text-dense text-foreground">
            <option value="">{t("audit.all")}</option>
            {ENTITIES.map((x) => (
              <option key={x} value={x}>
                {t(`audit.entities.${x}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.a} className="text-meta text-muted-foreground">{t("audit.action")}</label>
          <select id={ids.a} value={action} onChange={(e) => setAction(e.target.value)} className="h-9 rounded border border-input bg-surface px-2 text-dense text-foreground">
            <option value="">{t("audit.all")}</option>
            {ACTIONS.map((x) => (
              <option key={x} value={x}>
                {actionLabel(t, x)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {pages.isError ? (
        <p role="alert" className="text-dense text-destructive">{t("audit.loadError")}</p>
      ) : pages.isLoading ? (
        <p role="status" className="text-dense text-muted-foreground">{t("audit.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-dense text-muted-foreground">{t("audit.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-dense">
            <caption className="sr-only">{t("audit.title")}</caption>
            <thead>
              <tr className="text-meta text-muted-foreground">
                {["when", "who", "action", "entity", "details"].map((k) => (
                  <th key={k} scope="col" className="border-b border-border px-3 py-2 text-start font-medium">
                    {t(`audit.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} data-audit-row={e.action}>
                  <td className="whitespace-nowrap border-b border-border px-3 py-2 align-top tabular text-muted-foreground">
                    <Ltr>{formatDateTime(e.at)}</Ltr>
                  </td>
                  <td className="border-b border-border px-3 py-2 align-top text-foreground">{e.actor ? (e.actor.displayName ?? e.actor.uid) : e.actorKind === "share_link" ? t("audit.externalViewer") : t("audit.system")}</td>
                  <td className="border-b border-border px-3 py-2 align-top font-medium text-foreground">{actionLabel(t, e.action)}</td>
                  <td className="border-b border-border px-3 py-2 align-top text-muted-foreground">
                    {t(`audit.entities.${e.entity}`, { defaultValue: e.entity })}
                    {e.entityId ? (
                      <span className="block font-mono text-[11px]">
                        <Ltr>{e.entityId}</Ltr>
                      </span>
                    ) : null}
                  </td>
                  <td className="max-w-xs border-b border-border px-3 py-2 align-top text-meta text-muted-foreground">
                    <Ltr className="break-words">{auditDetails(e)}</Ltr>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages.hasNextPage ? (
        <div>
          <Button variant="secondary" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
            {pages.isFetchingNextPage ? t("common.loading") : t("audit.more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
