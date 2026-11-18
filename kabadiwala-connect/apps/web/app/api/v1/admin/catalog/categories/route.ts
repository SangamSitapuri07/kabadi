import { readCatalog } from '../catalog-read';
import { writeCatalog } from '../catalog-write';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return readCatalog(request); }
export function POST(request: Request) { return writeCatalog(request); }
