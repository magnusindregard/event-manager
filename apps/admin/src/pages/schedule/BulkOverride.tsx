import { useMutation } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LocationSelect, TagPicker } from "@/components/catalog-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type CatalogEvent, isConflict, type Occurrence, unwrap } from "../../api.js";
import { useApp } from "../../AppContext.js";

type Change<T> = { on: boolean; value: T };
type Draft = { location: Change<string | null>; link: Change<string>; tags: Change<string[] | null> };

const empty: Draft = { location: { on: false, value: null }, link: { on: false, value: "" }, tags: { on: false, value: null } };

/**
 * "Override these" for selected occurrences: each ticked field is set on all of them, or
 * cleared back to inheriting. One request, all or nothing.
 */
export function BulkOverride({ event, occurrences, open, onClose, onSaved, onConflict }: {
  event: CatalogEvent;
  occurrences: Occurrence[];
  open: boolean;
  onClose(): void;
  onSaved(): void;
  onConflict(): void;
}) {
  const { t } = useTranslation();
  const { api } = useApp();
  const [d, setD] = useState<Draft>(empty);
  const linkValid = !d.link.on || d.link.value.trim() === "" || /^https?:\/\/\S+$/.test(d.link.value.trim());
  const any = d.location.on || d.link.on || d.tags.on;

  const save = useMutation({
    mutationFn: async () => {
      const set = {
        ...(d.location.on ? { locationOverrideId: d.location.value } : {}),
        ...(d.link.on ? { externalUrlOverride: d.link.value.trim() || null } : {}),
        ...(d.tags.on ? { tagsOverride: d.tags.value } : {}),
      };
      return unwrap(await api.POST("/v1/events/{id}/occurrences/bulk-update", {
        params: { path: { id: event.id } },
        body: { items: occurrences.map((o) => ({ id: o.id, version: o.version })), set },
      }));
    },
    onSuccess: (r) => {
      toast.success(t("bulk.saved", { count: r.items.length }));
      setD(empty);
      onSaved();
    },
    onError: (e) => isConflict(e) && onConflict(),
  });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-md">
        <form
          className="flex h-full flex-col overflow-y-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (any && linkValid) save.mutate();
          }}
        >
          <SheetHeader>
            <SheetTitle>{t("bulk.title", { count: occurrences.length })}</SheetTitle>
            <SheetDescription>{t("bulk.hint")}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4">
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id="bulk-location-on" checked={d.location.on} onCheckedChange={(v) => setD({ ...d, location: { ...d.location, on: v === true } })} />
                <Label htmlFor="bulk-location-on">{t("bulk.changeLocation")}</Label>
              </div>
              {d.location.on && (
                <LocationSelect id="bulk-location" value={d.location.value} onChange={(value) => setD({ ...d, location: { on: true, value } })} noneLabel={t("bulk.inherit")} />
              )}
            </div>
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id="bulk-link-on" checked={d.link.on} onCheckedChange={(v) => setD({ ...d, link: { ...d.link, on: v === true } })} />
                <Label htmlFor="bulk-link-on">{t("bulk.changeLink")}</Label>
              </div>
              {d.link.on && (
                <>
                  <Input id="bulk-link" type="url" aria-label={t("occurrences.link")} placeholder="https://" value={d.link.value} onChange={(e) => setD({ ...d, link: { on: true, value: e.target.value } })} />
                  <p className="text-xs text-muted-foreground">{t("bulk.emptyInherits")}</p>
                </>
              )}
            </div>
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <Checkbox id="bulk-tags-on" checked={d.tags.on} onCheckedChange={(v) => setD({ ...d, tags: { on: v === true, value: v === true ? (d.tags.value ?? event.tagIds) : null } })} />
                <Label htmlFor="bulk-tags-on">{t("bulk.changeTags")}</Label>
              </div>
              {d.tags.on && (
                <>
                  <TagPicker id="bulk-tags" value={d.tags.value ?? []} onChange={(value) => setD({ ...d, tags: { on: true, value } })} />
                  <Button type="button" variant="link" size="sm" className="justify-self-start px-0" onClick={() => setD({ ...d, tags: { on: true, value: null } })}>
                    {t("bulk.tagsInherit")}
                  </Button>
                  {d.tags.value === null && <p className="text-xs text-muted-foreground">{t("bulk.tagsInheritOn")}</p>}
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("bulk.detachHint")}</p>
            {save.error && !isConflict(save.error) && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <SheetFooter>
            <Button type="submit" disabled={!any || !linkValid || save.isPending}>{t("bulk.apply", { count: occurrences.length })}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
