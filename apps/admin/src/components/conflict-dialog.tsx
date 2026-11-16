import { useTranslation } from "react-i18next";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Shown on 412 version_conflict: someone else saved first (ADR 0007, ETags). */
export function ConflictDialog({ open, onOpenChange, onReload }: { open: boolean; onOpenChange(open: boolean): void; onReload(): void }) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("conflict.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("conflict.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("conflict.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onReload}>{t("conflict.reload")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
