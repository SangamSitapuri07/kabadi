import { readCatalog } from '../../../catalog-read';
export const dynamic = 'force-dynamic';
export async function GET(request:Request, context:{params:Promise<{categoryId:string}>}) {
  const {categoryId} = await context.params;
  return readCatalog(request,categoryId);
}
