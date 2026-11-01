import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, UserMinus } from "lucide-react";
import { useApi } from "@/api/client";
import { ApiError, type OrgMember, type Role } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { useReauthGate } from "@/features/auth/reauth";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { useAuthStore } from "@/stores/authStore";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const ROLES: readonly Role[] = ["admin", "editor", "reviewer", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Hebrew text for the API errors of the member endpoints. */
function errorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === "last_admin") return t("members.errLastAdmin");
    if (e.code === "already_member") return t("members.errAlready");
    if (e.status === 400) return t("members.errEmail");
  }
  return t("members.errGeneric");
}

/**
 * Stage 10 (A-API-01) "חברי צוות" (admin): members and pending invitations, invite by email (the link is shown once
 * and copied by the admin — there is no email service yet), change role, remove. Every change is audited by the API
 * and needs MFA + a recent sign-in (A-API-02), handled by the shared re-authentication box.
 */
export function MembersPage() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { org } = useCurrentOrg();
  const myUid = useAuthStore((s) => s.session?.uid) ?? null;
  const orgId = org?.id ?? "";
  const ids = { email: useId(), role: useId(), url: useId() };
  const gate = useReauthGate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<{ url: string; email: string } | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const members = useQuery({ queryKey: ["members", orgId], queryFn: () => api.listMembers(orgId), enabled: Boolean(orgId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["members", orgId] });

  const invite = useMutation({
    mutationFn: () => api.inviteMember(orgId, { email: email.trim(), role }),
    onSuccess: (r) => {
      setCreated({ url: r.inviteUrl, email: r.member.email ?? email.trim() });
      setEmail("");
      setTouched(false);
      refresh();
    },
    onError: (e) => {
      if (!gate.handle(e, () => invite.mutate())) toast({ title: errorText(e, t), tone: "error" });
    },
  });
  const patch = useMutation({
    mutationFn: (v: { m: OrgMember; role: Role }) => api.patchMember(orgId, v.m.id, { role: v.role }),
    onSuccess: (m) => {
      toast({ title: t("members.roleChanged", { name: m.displayName ?? m.email ?? m.id, role: t(`members.roles.${m.role}`) }), tone: "success" });
      refresh();
    },
    onError: (e, v) => {
      if (!gate.handle(e, () => patch.mutate(v))) toast({ title: errorText(e, t), tone: "error" });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (m: OrgMember) => api.removeMember(orgId, m.id),
    onSuccess: (_r, m) => {
      toast({ title: t(m.status === "pending" ? "members.inviteRevoked" : "members.removed", { name: m.displayName ?? m.email ?? m.id }), tone: "success" });
      setRemoving(null);
      refresh();
    },
    onError: (e, m) => {
      setRemoving(null);
      if (!gate.handle(e, () => remove.mutate(m))) toast({ title: errorText(e, t), tone: "error" });
    },
  });

  if (!org) return null;
  const emailOk = EMAIL.test(email.trim());
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      toast({ title: t("members.copied"), tone: "success" });
    } catch {
      toast({ title: t("share.copyFailed"), tone: "error" });
    }
  };
  const list = members.data?.members ?? [];

  return (
    <div className="flex flex-col gap-4" data-members>
      {gate.element}
      <section aria-labelledby="invite-title" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <h2 id="invite-title" className="text-panel font-bold text-foreground">{t("members.inviteTitle")}</h2>
        <p className="text-dense text-muted-foreground">{t("members.inviteBody")}</p>
        <form
          className="flex flex-wrap items-end gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (emailOk) void gate.guard(() => invite.mutate());
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1">
            <label htmlFor={ids.email} className="text-dense font-medium text-foreground">{t("members.email")}</label>
            <Input
              id={ids.email}
              type="email"
              dir="ltr"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={touched && !emailOk ? true : undefined}
              aria-describedby={touched && !emailOk ? `${ids.email}-err` : undefined}
              className="text-start"
            />
            {touched && !emailOk ? (
              <p id={`${ids.email}-err`} role="alert" className="text-meta text-destructive">{t("members.errEmail")}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.role} className="text-dense font-medium text-foreground">{t("members.role")}</label>
            <select id={ids.role} value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-10 rounded border border-input bg-surface px-2 text-body text-foreground">
              {ROLES.map((r) => (
                <option key={r} value={r}>{t(`members.roles.${r}`)}</option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={invite.isPending || gate.pending}>
            <Link2 aria-hidden />
            {t("members.createInvite")}
          </Button>
        </form>
        <p className="text-meta text-muted-foreground">{t(`members.roleHints.${role}`)}</p>
        {created ? (
          <div className="flex flex-col gap-2 rounded-md border border-conf-high/40 bg-conf-high/[0.06] p-4" data-invite-created>
            <p className="font-bold text-foreground">
              {t("members.inviteCreated", { email: "" })}
              <Ltr>{created.email}</Ltr>
            </p>
            <label htmlFor={ids.url} className="sr-only">{t("members.inviteUrl")}</label>
            <div className="flex gap-2">
              <Input id={ids.url} readOnly dir="ltr" value={created.url} onFocus={(e) => e.currentTarget.select()} className="flex-1 font-mono text-meta" />
              <Button onClick={() => void copy()}>
                <Copy aria-hidden />
                {t("members.copy")}
              </Button>
            </div>
            <p className="text-dense text-foreground">{t("members.inviteOnce")}</p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="members-title" className="flex flex-col gap-2">
        <h2 id="members-title" className="text-panel font-bold text-foreground">
          {t("members.listTitle")}
          {list.length ? <span className="ms-2 text-dense font-normal text-muted-foreground">{list.length}</span> : null}
        </h2>
        {members.isError ? (
          <p role="alert" className="text-body text-destructive">{t("members.loadError")}</p>
        ) : members.isLoading ? (
          <p role="status" className="text-body text-muted-foreground">{t("common.loading")}</p>
        ) : (
          // relative: the sr-only header text (position: absolute) stays inside the scroll box on a phone
          <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full border-collapse text-dense">
              <caption className="sr-only">{t("members.listTitle")}</caption>
              <thead>
                <tr className="h-9 border-b border-border bg-surface-sunken text-meta text-muted-foreground">
                  <th scope="col" className="px-3 text-start font-medium">{t("members.colMember")}</th>
                  <th scope="col" className="w-36 px-3 text-start font-medium">{t("members.colRole")}</th>
                  <th scope="col" className="w-40 px-3 text-start font-medium">{t("members.colStatus")}</th>
                  <th scope="col" className="w-28 px-3 text-end font-medium"><span className="sr-only">{t("members.colActions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => {
                  const me = m.uid !== null && m.uid === myUid;
                  const name = m.displayName ?? m.email ?? m.id;
                  return (
                    <tr key={m.id} className="border-b border-border last:border-0" data-member={m.id} data-member-status={m.status}>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">
                            {m.displayName ?? <Ltr>{m.email ?? m.id}</Ltr>}
                            {me ? <span className="ms-1.5 text-meta font-normal text-muted-foreground">{t("members.you")}</span> : null}
                          </span>
                          {m.displayName && m.email ? <Ltr className="text-meta text-muted-foreground">{m.email}</Ltr> : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <select
                          value={m.role}
                          disabled={me || patch.isPending || gate.pending}
                          aria-label={t("members.roleFor", { name })}
                          title={me ? t("members.selfRole") : undefined}
                          onChange={(e) => {
                            const v = { m, role: e.target.value as Role };
                            void gate.guard(() => patch.mutate(v));
                          }}
                          className="h-8 rounded border border-input bg-surface px-1.5 text-dense text-foreground disabled:opacity-60"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>{t(`members.roles.${r}`)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-meta font-medium", m.status === "pending" ? "bg-conf-mid/15 text-foreground" : "bg-conf-high/15 text-foreground")}>
                          {t(`members.status.${m.status}`)}
                        </span>
                        <span className="ms-1.5 text-meta text-muted-foreground">
                          {m.status === "pending" && m.expiresAt ? (
                            <>
                              {t("members.expires", { date: "" })}
                              <Ltr>{formatDate(m.expiresAt)}</Ltr>
                            </>
                          ) : (
                            <Ltr>{formatDate(m.createdAt)}</Ltr>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-end">
                        {!me ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => setRemoving(m)}
                            aria-label={t(m.status === "pending" ? "members.revokeFor" : "members.removeFor", { name })}
                          >
                            <UserMinus aria-hidden />
                            {t(m.status === "pending" ? "members.revoke" : "members.remove")}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent role="alertdialog" className="max-w-md" aria-describedby="member-remove-body">
          <DialogHeader>
            <DialogTitle>{t(removing?.status === "pending" ? "members.revokeTitle" : "members.removeTitle")}</DialogTitle>
            <DialogDescription id="member-remove-body">
              {t(removing?.status === "pending" ? "members.revokeBody" : "members.removeBody", { name: removing?.displayName ?? removing?.email ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => removing && void gate.guard(() => remove.mutate(removing))}>
              <UserMinus aria-hidden />
              {t(removing?.status === "pending" ? "members.revoke" : "members.remove")}
            </Button>
            <Button variant="secondary" onClick={() => setRemoving(null)} autoFocus>
              {t("members.keep")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
