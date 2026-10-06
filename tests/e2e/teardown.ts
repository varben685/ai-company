import { PrismaClient } from "@prisma/client";
import { planningQueue } from "@company/integrations";
export default async function teardown() {
  const schema = process.env.M1_E2E_SCHEMA;
  if (!schema || !/^m1_e2e_[a-f0-9]{32}$/.test(schema))
    throw new Error("Refusing unsafe schema cleanup");
  const db = new PrismaClient();
  await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await db.$disconnect();
  const queue = planningQueue(process.env.REDIS_URL!, schema);
  await queue.obliterate({ force: true });
  await queue.close();
}
