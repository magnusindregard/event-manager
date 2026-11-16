import { Alert, Button, Paper, Stack, Typography } from "@mui/material";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
  // MUI X Data Grid (MIT): server-driven "load more" instead of Pro features.
  const columns: GridColDef<Entry>[] = [
    { field: "at", headerName: t("audit.when"), width: 180, valueFormatter: (v: string) => fmt.format(new Date(v)) },
    { field: "actor", headerName: t("audit.who"), width: 220, valueGetter: (_v, row) => row.actor.email ?? row.actor.clientId ?? "system" },
    { field: "action", headerName: t("audit.action"), width: 180 },
    { field: "entityType", headerName: t("audit.entity"), width: 120 },
    { field: "diff", headerName: t("audit.changes"), flex: 1, minWidth: 240, valueGetter: (_v, row) => describeDiff(row.diff) },
  ];

  return (
    <Stack spacing={2}>
      <Typography variant="h4" component="h1">{t("audit.title")}</Typography>
      {query.isError && <Alert severity="error">{t("error.generic")}</Alert>}
      <Paper sx={{ width: "100%" }}>
        <DataGrid rows={rows} columns={columns} loading={query.isLoading} hideFooter autoHeight disableRowSelectionOnClick density="compact" />
      </Paper>
      {query.hasNextPage && (
        <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} sx={{ alignSelf: "flex-start" }}>
          {t("audit.loadMore")}
        </Button>
      )}
    </Stack>
  );
}
