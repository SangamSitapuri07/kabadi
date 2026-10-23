import { closePrisma, getPrisma } from "../src/lib/prisma";
import { ensureSeeded } from "../prisma/seed";

async function main() {
  await getPrisma();
  await ensureSeeded();
  console.log("PostgreSQL schema verified and initial data ready.");
  await closePrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
