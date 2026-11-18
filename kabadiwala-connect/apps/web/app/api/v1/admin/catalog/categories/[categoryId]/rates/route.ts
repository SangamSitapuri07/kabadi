import { readCatalog } from '../../../catalog-read';
import { writeCatalog } from '../../../catalog-write';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ categoryId: string }> }) {
  const { categoryId } = await context.params;
  return readCatalog(request, categoryId);
}
export async function POST(request: Request, context: { params: Promise<{ categoryId: string }> }) {
  const { categoryId } = await context.params;
  return writeCatalog(request, categoryId);
}
