import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "../auth/AuthProvider.js";

export function SignIn() {
  const { t } = useTranslation();
  const auth = useAuth();
  const dev = import.meta.env.VITE_AUTH_MODE === "dev";
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="grid min-h-svh place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle><h1>{t("app.title")}</h1></CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              // Misconfiguration (wrong authority, unknown tenant) surfaces here instead of a dead button.
              auth.signIn(dev ? email : undefined).catch((err: unknown) => {
                console.error(err);
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          >
            {error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>{t("auth.failed")}</AlertTitle>
                <AlertDescription className="break-words">{error}</AlertDescription>
              </Alert>
            )}
            {dev && (
              <Field label={t("auth.devEmail")} htmlFor="email">
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </Field>
            )}
            <Button type="submit" className="w-full">{t("auth.signIn")}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
