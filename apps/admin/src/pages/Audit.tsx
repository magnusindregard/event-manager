import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type ColumnDef, DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type AuditPage, unwrap } from "../api.js";
import { useApp } from "../AppContext.js";

type Entry = AuditPage["items"][number];

function describeDiff(diff: unknown): string {
  if (!diff || typeof diff !== "object") return "";
  return Object.entries(diff as Record<string, unknown>)
    .map(([k, v]) => {
      if (v && typeof v === "object" && "from" in v && "to" in v) {
        const c = v as { from: unknown; to: unknown };
        return `${k}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("; ");
}

export function Audit() {
  const { t, i18n } = useTranslation();
  const { api, accountId } = useApp();

  const query = useInfiniteQuery({
    queryKey: ["audit", accountId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(await api.GET("/v1/audit", { params: { query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  // Server-driven "load more" (cursor pagination); the table only renders.
  const columns: ColumnDef<Entry>[] = [
    { id: "at", header: t("audit.when"), cell: ({ row }) => <span className="whitespace-nowrap">{fmt.format(new Date(row.original.at))}</span> },
    { id: "actor", header: t("audit.who"), cell: ({ row }) => row.original.actor.email ?? row.original.actor.clientId ?? "system" },
    { id: "action", header: t("audit.action"), cell: ({ row }) => <code className="text-xs">{row.original.action}</code> },
    { id: "entity", header: t("audit.entity"), accessorKey: "entityType" },
    { id: "diff", header: t("audit.changes"), cell: ({ row }) => <span className="text-muted-foreground">{describeDiff(row.original.diff)}</span> },
  ];

  return (
    <div>
      <PageHeader title={t("audit.title")} />
      <div className="space-y-4">
        {query.isError && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>{t("error.generic")}</AlertDescription>
          </Alert>
        )}
        <DataTable columns={columns} data={rows} loading={query.isLoading} empty={t("common.empty")} getRowId={(r) => r.id} />
        {query.hasNextPage && (
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {t("audit.loadMore")}
          </Button>
        )}
      </div>
    </div>
  );
}
