import { CalendarDays, ChevronsUpDown, History, LogOut, MapPin, Menu, Repeat, Settings, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useApp } from "../AppContext.js";
import { useAuth } from "../auth/AuthProvider.js";
import { LANGUAGES, setLanguage } from "../i18n.js";

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const { me, accountId, selectAccount } = useApp();
  const account = me?.accounts.find((a) => a.accountId === accountId);

  const nav = [
    { to: "/events", label: t("nav.events"), icon: CalendarDays },
    { to: "/locations", label: t("nav.locations"), icon: MapPin },
    { to: "/settings", label: t("nav.settings"), icon: Settings },
    { to: "/members", label: t("nav.members"), icon: Users },
    { to: "/audit", label: t("nav.audit"), icon: History },
  ];

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-2 pt-1">
        <div className="text-xs text-muted-foreground">{t("app.title")}</div>
        <div className="truncate text-sm font-semibold">{account?.name}</div>
      </div>

      <nav aria-label={t("app.title")} className="flex flex-1 flex-col gap-0.5">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-auto justify-between px-2 py-1.5 text-left">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{auth.user?.name ?? auth.user?.email}</span>
              <span className="block truncate text-xs text-muted-foreground">{auth.user?.email}</span>
            </span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel>{t("common.language")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={i18n.language} onValueChange={setLanguage}>
            {LANGUAGES.map((l) => (
              <DropdownMenuRadioItem key={l.code} value={l.code}>{l.label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {(me?.accounts.length ?? 0) > 1 && (
            <DropdownMenuItem onSelect={() => selectAccount(null)}>
              <Repeat /> {t("account.switch")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void auth.signOut()}>
            <LogOut /> {t("auth.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-svh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-svh border-r bg-sidebar md:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("common.menu")}>
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 bg-sidebar p-0">
            <SheetTitle className="sr-only">{t("common.menu")}</SheetTitle>
            <Sidebar onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <span className="text-sm font-semibold">{t("app.title")}</span>
      </header>

      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
