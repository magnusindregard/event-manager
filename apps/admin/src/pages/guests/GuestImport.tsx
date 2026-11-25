import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, FileUp, RefreshCw, Search } from "lucide-react";
import { type ChangeEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Field } from "@/components/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiProblem, type GuestImportDraft, type GuestImportPreview, type ImportMapping, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

// Guest list import (docs/registration.md, "Guest list import"): upload, map columns,
// preview, import. Nothing is saved before the last step, and guests missing from the file
// are only removed if staff tick them.
//
// With HubSpot connected, the guests can come from a HubSpot list instead (docs/hubspot.md,
// milestone 6): staff search the portal's lists and pick one; the worker fetches its members,
// and the same mapping, preview and import follow. The event remembers the list, so "Refresh
// from HubSpot" fetches it again.

const FIELDS = ["email", "name", "firstName", "lastName", "locale", "guestAllowed", "externalContactId"] as const;
type FieldKey = (typeof FIELDS)[number];
const NONE = "-";
const MAX_BYTES = 10 * 1024 * 1024;

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

export function GuestImport({ eventId, open, onClose, onDone, hubspot = false, refresh = false }: {
  eventId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** HubSpot is connected: offer a HubSpot list as the source. */
  hubspot?: boolean;
  /** Open straight on fetching the remembered HubSpot list again. */
  refresh?: boolean;
}) {
  const { t } = useTranslation();
  const { api } = useApp();
  const [source, setSource] = useState<"file" | "hubspot">("file");
  /** Waiting for the worker to fetch a HubSpot list: the request's time, to tell its result from an earlier fetch's. */
  const [fetching, setFetching] = useState<string | null>(null);
  const [draft, setDraft] = useState<GuestImportDraft | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [preview, setPreview] = useState<GuestImportPreview | null>(null);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFetching(null);
    setSource("file");
    setDraft(null);
    setMapping({});
    setPreview(null);
    setRemove(new Set());
    setError(null);
  };
  const close = () => {
    if (draft) void api.DELETE("/v1/guest-imports/{id}", { params: { path: { id: draft.id } } });
    reset();
    onClose();
  };
  const problem = (e: unknown) => (e instanceof ApiProblem && e.code === "validation_failed" ? e.message : e instanceof ApiProblem && e.code === "not_found" ? t("guests.import.expired") : t("error.generic"));

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new ApiProblem(422, "validation_failed", t("guests.import.tooLarge"));
      const content = await toBase64(file);
      return unwrap(await api.POST("/v1/events/{id}/guest-imports", { params: { path: { id: eventId } }, body: { fileName: file.name, content } }));
    },
    onSuccess: (d) => {
      setDraft(d);
      setMapping(d.mapping);
      setPreview(null);
      setError(null);
    },
    onError: (e) => setError(problem(e)),
  });

  const check = useMutation({
    mutationFn: async () => unwrap(await api.POST("/v1/guest-imports/{id}/preview", { params: { path: { id: draft!.id } }, body: { mapping } })),
    onSuccess: (p) => {
      setPreview(p);
      setRemove(new Set());
      setError(null);
    },
    onError: (e) => setError(problem(e)),
  });

  const commit = useMutation({
    mutationFn: async () => {
      const res = unwrap(await api.POST("/v1/guest-imports/{id}/commit", { params: { path: { id: draft!.id } }, body: { mapping } }));
      const removed = remove.size
        ? unwrap(await api.POST("/v1/events/{id}/invitations/remove", { params: { path: { id: eventId } }, body: { ids: [...remove] } })).removed.length
        : 0;
      return { ...res, removed };
    },
    onSuccess: (r) => {
      toast.success(t("guests.import.done", { added: r.added, updated: r.updated, removed: r.removed }));
      reset();
      onDone();
      onClose();
    },
    onError: (e) => setError(problem(e)),
  });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) upload.mutate(f);
    e.target.value = "";
  };
  const setCol = (f: FieldKey, v: string) => {
    const next: ImportMapping = { ...mapping };
    if (v === NONE) delete next[f];
    else {
      const col = Number(v);
      for (const k of FIELDS) if (next[k] === col) delete next[k];
      next[f] = col;
      if (f === "name") {
        delete next.firstName;
        delete next.lastName;
      }
      if (f === "firstName" || f === "lastName") delete next.name;
    }
    setMapping(next);
    setPreview(null);
  };

  /** Another source: what was staged from the other one goes. */
  const switchTo = (k: "file" | "hubspot") => {
    if (k === source) return;
    if (draft) void api.DELETE("/v1/guest-imports/{id}", { params: { path: { id: draft.id } } });
    reset();
    setSource(k);
  };
  const takeDraft = (d: GuestImportDraft) => {
    setDraft(d);
    setMapping(d.mapping);
    setPreview(null);
    setError(null);
  };

  // ── From HubSpot ──
  const fetchList = useMutation({
    mutationFn: async (list: { listId: string; listName: string } | null) =>
      unwrap(list
        ? await api.POST("/v1/events/{id}/guest-source", { params: { path: { id: eventId } }, body: list })
        : await api.POST("/v1/events/{id}/guest-source/refresh", { params: { path: { id: eventId } } })),
    onMutate: () => {
      setDraft(null);
      setPreview(null);
      setError(null);
    },
    onSuccess: (r) => setFetching(r.source?.requestedAt ?? null),
    onError: (e) => setError(problem(e)),
  });
  const sourceQuery = useQuery({
    queryKey: ["guest-source", eventId],
    enabled: open && !!fetching,
    queryFn: async () => unwrap(await api.GET("/v1/events/{id}/guest-source", { params: { path: { id: eventId } } })).source,
    refetchInterval: 1500,
  });
  useEffect(() => {
    const s = sourceQuery.data;
    // The page caches this query: until the fresh read comes back it may still show the last fetch's result.
    if (!fetching || !s || s.requestedAt !== fetching || s.status === "fetching") return;
    setFetching(null);
    if (s.status === "failed") return setError(s.error ?? t("error.generic"));
    if (!s.importId) return setError(t("guests.import.expired"));
    void (async () => {
      try {
        takeDraft(unwrap(await api.GET("/v1/guest-imports/{id}", { params: { path: { id: s.importId! } } })));
      } catch (e) {
        setError(problem(e));
      }
    })();
    // takeDraft and problem only set state.
  }, [sourceQuery.data, fetching]);
  // "Refresh from HubSpot": start at once.
  useEffect(() => {
    if (open && refresh) {
      setSource("hubspot");
      fetchList.mutate(null);
    }
  }, [open, refresh]);

  const removable = preview?.missing.filter((m) => m.removable) ?? [];
  const blocked = preview?.missing.filter((m) => !m.removable) ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("guests.import.title")}</DialogTitle>
          <DialogDescription>{t("guests.import.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          {hubspot && !refresh && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("guests.import.source")}>
              {(["file", "hubspot"] as const).map((k) => (
                <Button key={k} size="sm" role="radio" aria-checked={source === k} variant={source === k ? "default" : "outline"}
                  onClick={() => switchTo(k)}>
                  {t(`guests.import.sources.${k}`)}
                </Button>
              ))}
            </div>
          )}
          {source === "hubspot" ? (
            <HubSpotListPicker disabled={fetchList.isPending || !!fetching} onPick={(l) => fetchList.mutate(l)} hideSearch={refresh} />
          ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant={draft ? "outline" : "default"} disabled={upload.isPending}>
              <label htmlFor="guest-file" className="cursor-pointer">
                <FileUp /> {draft ? t("guests.import.otherFile") : t("guests.import.chooseFile")}
              </label>
            </Button>
            <input id="guest-file" type="file" className="sr-only" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} />
            {upload.isPending && <span className="text-sm text-muted-foreground">{t("guests.import.reading")}</span>}
            {draft && <span className="text-sm">{t("guests.import.fileInfo", { name: draft.fileName, count: draft.rowCount })}</span>}
          </div>
          )}
          {(fetchList.isPending || !!fetching) && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><RefreshCw className="size-4 animate-spin" /> {t("guests.import.fetching")}</p>
          )}
          {source === "hubspot" && draft && <p className="text-sm">{t("guests.import.fileInfo", { name: draft.fileName, count: draft.rowCount })}</p>}

          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {draft && (
            <section className="grid gap-3" aria-labelledby="mapping-title">
              <h3 id="mapping-title" className="text-sm font-medium">{t("guests.import.mapping")}</h3>
              <p className="text-muted-foreground text-sm">{t("guests.import.mappingHelp")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <Field key={f} label={t(`guests.import.fields.${f}`) + (f === "email" ? " *" : "")} htmlFor={`map-${f}`}>
                    <Select value={mapping[f] === undefined ? NONE : String(mapping[f])} onValueChange={(v) => setCol(f, v)}>
                      <SelectTrigger id={`map-${f}`} className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{t("guests.import.notInFile")}</SelectItem>
                        {draft.headers.map((h, i) => <SelectItem key={i} value={String(i)}>{h}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                ))}
              </div>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>{draft.headers.map((h, i) => <TableHead key={i}>{h}</TableHead>)}</TableRow>
                  </TableHeader>
                  <TableBody>
                    {draft.sample.map((r, i) => <TableRow key={i}>{r.map((c, j) => <TableCell key={j} className="max-w-48 truncate">{c}</TableCell>)}</TableRow>)}
                  </TableBody>
                </Table>
              </div>
              <div>
                <Button variant="outline" onClick={() => check.mutate()} disabled={mapping.email === undefined || check.isPending}>{t("guests.import.check")}</Button>
              </div>
            </section>
          )}

          {preview && (
            <section className="grid gap-3" aria-labelledby="preview-title" aria-live="polite">
              <h3 id="preview-title" className="text-sm font-medium">{t("guests.import.preview")}</h3>
              <ul className="grid gap-1 text-sm">
                <li>{t("guests.import.willAdd", { count: preview.added })}</li>
                <li>{t("guests.import.willUpdate", { count: preview.updated })}</li>
                <li>{t("guests.import.unchanged", { count: preview.unchanged })}</li>
                {preview.errors.length > 0 && <li className="text-destructive">{t("guests.import.willSkip", { count: preview.errors.length })}</li>}
              </ul>
              {preview.errors.length > 0 && (
                <div className="max-h-48 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead>{t("guests.import.row")}</TableHead>
                        <TableHead>{t("guests.import.problem")}</TableHead>
                        <TableHead>{t("guests.import.value")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.errors.map((e) => (
                        <TableRow key={`${e.line}-${e.field}`}>
                          <TableCell className="tabular-nums">{e.line}</TableCell>
                          <TableCell>{t(`guests.import.errors.${e.code}`)}</TableCell>
                          <TableCell className="max-w-48 truncate">{e.value}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {preview.missing.length > 0 && (
                <div className="grid gap-2 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("guests.import.missing", { count: preview.missing.length })}</p>
                  <p className="text-muted-foreground text-sm">{t("guests.import.missingHelp")}</p>
                  {removable.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Checkbox id="remove-all" checked={remove.size === removable.length ? true : remove.size ? "indeterminate" : false}
                        onCheckedChange={(v) => setRemove(v === true ? new Set(removable.map((m) => m.id)) : new Set())} />
                      <Label htmlFor="remove-all">{t("guests.import.removeAll", { count: removable.length })}</Label>
                    </div>
                  )}
                  <ul className="grid max-h-48 gap-1 overflow-y-auto text-sm">
                    {preview.missing.map((m) => (
                      <li key={m.id} className="flex items-center gap-2">
                        {m.removable ? (
                          <Checkbox id={`rm-${m.id}`} checked={remove.has(m.id)} aria-label={t("guests.import.removeOne", { email: m.email })}
                            onCheckedChange={(v) => {
                              const next = new Set(remove);
                              if (v === true) next.add(m.id);
                              else next.delete(m.id);
                              setRemove(next);
                            }} />
                        ) : <span className="size-4" aria-hidden />}
                        <span>{m.name ? `${m.name} · ` : ""}{m.email}</span>
                        {!m.removable && <span className="text-muted-foreground text-xs">{t("guests.import.blocked")}</span>}
                      </li>
                    ))}
                  </ul>
                  {blocked.length > 0 && <p className="text-muted-foreground text-xs">{t("guests.import.blockedHelp", { count: blocked.length })}</p>}
                </div>
              )}
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>{t("common.cancel")}</Button>
          <Button onClick={() => commit.mutate()} disabled={!preview || commit.isPending || preview.added + preview.updated + remove.size === 0}>
            {remove.size ? t("guests.import.commitAndRemove", { count: preview!.added + preview!.updated, removed: remove.size }) : t("guests.import.commit", { count: (preview?.added ?? 0) + (preview?.updated ?? 0) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Searches the portal's contact lists by name; picking one fetches it. */
function HubSpotListPicker({ onPick, disabled, hideSearch }: { onPick: (l: { listId: string; listName: string }) => void; disabled: boolean; hideSearch: boolean }) {
  const { t } = useTranslation();
  const { api, accountId } = useApp();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const lists = useQuery({
    queryKey: ["hubspot-lists", accountId, term],
    enabled: !hideSearch,
    queryFn: async () => unwrap(await api.GET("/v1/integrations/hubspot/lists", { params: { query: { q: term } } })).items,
  });
  if (hideSearch) return null;
  return (
    <div className="grid gap-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <Input type="search" className="w-full sm:w-72" placeholder={t("guests.import.searchLists")} aria-label={t("guests.import.searchLists")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="outline"><Search /> {t("guests.import.search")}</Button>
      </form>
      {lists.error && <p className="text-sm text-destructive">{lists.error.message}</p>}
      {lists.data && lists.data.length === 0 && <p className="text-sm text-muted-foreground">{t("guests.import.noLists")}</p>}
      {lists.data && lists.data.length > 0 && (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-md border text-sm">
          {lists.data.map((l) => (
            <li key={l.listId} className="flex items-center justify-between gap-2 px-3 py-2">
              <span>
                {l.name}
                <span className="text-muted-foreground"> · {l.size === null ? t(`guests.import.listKinds.${l.processingType === "MANUAL" ? "static" : "active"}`) : t("guests.import.members", { count: l.size })}</span>
              </span>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => onPick({ listId: l.listId, listName: l.name })}>{t("guests.import.useList")}</Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t("guests.import.hubspotHint")}</p>
    </div>
  );
}
