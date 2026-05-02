import { Workbench } from "@/components/workbench";
import { readTemplateConfig } from "@/lib/templates/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const initialTemplates = await readTemplateConfig();
  return <Workbench initialTemplates={initialTemplates} />;
}
