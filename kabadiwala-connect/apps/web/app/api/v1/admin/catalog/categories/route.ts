import { readCatalog } from '../catalog-read';
export const dynamic = 'force-dynamic';
export function GET(request:Request) { return readCatalog(request); }
