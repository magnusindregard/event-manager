import { Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

export function ComingSoon({ titleKey, milestone }: { titleKey: string; milestone: number }) {
  const { t } = useTranslation();
  return (
    <>
      <Typography variant="h4" component="h1" gutterBottom>{t(titleKey)}</Typography>
      <Typography color="text.secondary">{t("comingSoon", { n: milestone })}</Typography>
    </>
  );
}
