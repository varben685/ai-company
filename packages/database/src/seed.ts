import "dotenv/config";
import { PrismaClient } from "./index";
const db = new PrismaClient();
async function seed() {
  await db.project.upsert({
    where: { id: "00000000-0000-4000-8000-000000000001" },
    update: {},
    create: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Sample Notes App",
      description: "A notes application for the M1 acceptance task.",
      context: {
        product:
          "Notes have title and content and belong to the signed-in user.",
        architecture:
          "TypeScript, NestJS REST API, Next.js UI, PostgreSQL. Controllers contain no business logic.",
        codingStandards: "Strict TypeScript; services use repositories.",
        testing: "Every new endpoint receives integration tests.",
        security: "Enforce note ownership for every operation.",
        decisions: "No existing route names or file layout have been supplied.",
      },
    },
  });
}
void seed().finally(() => db.$disconnect());
