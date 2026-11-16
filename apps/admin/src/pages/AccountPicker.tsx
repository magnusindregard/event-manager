import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApp } from "../AppContext.js";

export function AccountPicker() {
  const { t } = useTranslation();
  const { me, selectAccount } = useApp();
  const accounts = me?.accounts ?? [];
  return (
    <main className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle><h1>{t("account.choose")}</h1></CardTitle>
        </CardHeader>
        <CardContent>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("account.none")}</p>
          ) : (
            <ul className="-mx-2 grid gap-1">
              {accounts.map((a) => (
                <li key={a.accountId}>
                  <button
                    type="button"
                    onClick={() => selectAccount(a.accountId)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <span>
                      <span className="block text-sm font-medium">{a.name}</span>
                      <span className="block text-xs text-muted-foreground">{a.roles.map((r) => t(`members.roles.${r}`, r)).join(", ")}</span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
