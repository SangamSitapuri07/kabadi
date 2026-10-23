import fs from "fs";
import path from "path";
import { WORKSPACE_ROOT } from "../src/lib/paths";
import { closePrisma, getPrisma } from "../src/lib/prisma";

/**
 * Closed-Loop Active Learning Dataset Exporter
 * ============================================
 * Exports human-confirmed (`humanConfirmedAt != null`) field camera scans from
 * PostgreSQL (`AIScanRecord`) + `.storage-private/ai-scans/` into standard class
 * subdirectories under `ml/datasets/scrap/<materialSlug>/` so running:
 *
 *   npx tsx apps/api/scripts/export-active-learning-dataset.ts
 *   .venv/bin/python ml/train_all.py
 *
 * continuously retrains the self-hosted `.onnx` CNN weights on real street photos
 * with zero third-party API cost.
 */
async function main() {
  const prisma = await getPrisma();
  const privateDir = path.join(WORKSPACE_ROOT, ".storage-private", "ai-scans");
  const outRoot = path.join(WORKSPACE_ROOT, "ml", "datasets", "scrap");

  const confirmedScans = await prisma.aIScanRecord.findMany({
    where: {
      scanType: "MATERIAL_CLASSIFICATION",
      humanConfirmedAt: { not: null },
      mediaStorageKey: { not: null },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  let exportedCount = 0;
  for (const scan of confirmedScans) {
    if (!scan.mediaStorageKey) continue;
    const srcPath = path.join(privateDir, path.basename(scan.mediaStorageKey));
    if (!fs.existsSync(srcPath)) continue;

    const json = (scan.structuredResultJson ?? {}) as Record<string, unknown>;
    const det = (json.detectedMaterial ?? {}) as Record<string, unknown>;
    const slug = typeof det.slug === "string" ? det.slug : null;
    if (!slug) continue;

    const destDir = path.join(outRoot, slug);
    fs.mkdirSync(destDir, { recursive: true });
    const ext = path.extname(srcPath) || ".png";
    const destPath = path.join(destDir, `${scan.id}${ext}`);
    fs.copyFileSync(srcPath, destPath);
    exportedCount++;
  }

  console.log(
    JSON.stringify({
      confirmedScansFound: confirmedScans.length,
      exportedImagesCount: exportedCount,
      datasetTargetDir: outRoot,
    })
  );
  await closePrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
