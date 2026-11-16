import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/page";

export function ComingSoon({ titleKey, milestone }: { titleKey: string; milestone: number }) {
  const { t } = useTranslation();
  return <PageHeader title={t(titleKey)} description={t("comingSoon", { n: milestone })} />;
}
