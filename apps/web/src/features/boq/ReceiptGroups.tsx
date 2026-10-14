import { useTranslation } from "react-i18next";
import { groupNo, groupsOf } from "./model";
import { useLineEvidence } from "./queries";

/** Receipt extra for composite lines: the "ק-n" switch groups behind the quantity, per sheet (fetched on open). */
export function ReceiptGroups({
  projectId,
  buildId,
  lineId,
  sheetLabel,
}: {
  projectId: string;
  buildId: string | null;
  lineId: string;
  sheetLabel: (sheetId: string) => string;
}) {
  const { t } = useTranslation();
  const ev = useLineEvidence(projectId, lineId, buildId);
  if (ev.isLoading) return <p className="text-meta text-muted-foreground">{t("boq.evidenceLoading")}</p>;
  const groups = groupsOf(ev.data?.items ?? []);
  if (!groups.length) return null;
  const bySheet = new Map<string, string[]>();
  for (const g of groups) bySheet.set(g.sheetId, [...(bySheet.get(g.sheetId) ?? []), t("boq.groupShort", { n: groupNo(g.linkGroupId) })]);
  return (
    <div className="flex flex-col gap-0.5 text-meta" data-receipt-groups>
      <span className="text-muted-foreground">{t("boq.receiptGroupList", { count: groups.length })}</span>
      {[...bySheet].map(([sheetId, chips]) => (
        <span key={sheetId} className="text-foreground">
          <bdi>{sheetLabel(sheetId)}</bdi>: {chips.join(", ")}
        </span>
      ))}
    </div>
  );
}
