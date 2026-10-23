Real field camera photos exported by the active-learning loop live here.

Expected layout:
  ml/datasets/scrap/<material-slug>/*.jpg|png
  ml/datasets/xray/<device-slug>/*.jpg|png

Images are intentionally NOT committed to Git. Run:
  npx tsx apps/api/scripts/export-active-learning-dataset.ts
