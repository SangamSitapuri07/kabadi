'use client';
import { useEffect, useRef, useState } from 'react';
import { CatalogAdmin } from './catalog-admin';

type Category = {id:string;name:string;active:boolean};
type Rate = {id:string;effectiveFrom:string;paisePerKg:number};
type Page<T> = {items:T[];nextAfter:string|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record=(v:unknown):v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function page<T>(value:unknown,field:'categories'|'rates'):Page<T> {
  if (!record(value) || !record(value.data)) throw Error('Invalid response');
  const data=value.data, items=data[field], next=data.nextAfter;
  if (!Array.isArray(items) || items.length>50 || (next !== null && (typeof next !== 'string' || !uuid.test(next)))) throw Error('Invalid page');
  for (const item of items) {
    if (!record(item) || typeof item.id !== 'string' || !uuid.test(item.id)) throw Error('Invalid item');
    if (field === 'categories') {
      if (typeof item.name !== 'string' || !item.name.trim() || Array.from(item.name).length>100 || typeof item.active !== 'boolean') throw Error('Invalid category');
    } else if (typeof item.effectiveFrom !== 'string' || !Number.isFinite(Date.parse(item.effectiveFrom)) || typeof item.paisePerKg !== 'number' || !Number.isInteger(item.paisePerKg) || item.paisePerKg < 0 || item.paisePerKg > 1000000000) throw Error('Invalid rate');
  }
  return {items:items as T[],nextAfter:next};
}
export function CatalogViewer({disabled=false}:{disabled?:boolean}) {
  const [categories,setCategories]=useState<Page<Category>|null>(null);
  const [rates,setRates]=useState<Page<Rate>|null>(null);
  const [selected,setSelected]=useState<Category|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const generation=useRef(0);
  useEffect(()=>{
    const invalidate=()=>{if (document.visibilityState === 'hidden') { generation.current++; setCategories(null); setRates(null); setSelected(null); setBusy(false); setMessage(''); }};
    document.addEventListener('visibilitychange',invalidate);
    return ()=>{generation.current++; document.removeEventListener('visibilitychange',invalidate);};
  },[]);
  async function loadCategories(after:string|null=null) {
    const current=++generation.current; setBusy(true); setMessage(''); setRates(null); setSelected(null); setCategories(null);
    try {
      const path='/api/v1/admin/catalog/categories'+(after ? `?after=${encodeURIComponent(after)}` : '');
      const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (current!==generation.current) return;
      if (response.status===401 || response.status===403) {setMessage('Admin access is required to view the catalog.'); return;}
      if (!response.ok) throw Error('Unavailable');
      const data=page<Category>(await response.json(),'categories');
      if (current===generation.current) setCategories(data);
    } catch {if (current===generation.current) setMessage('Catalog could not be loaded. Please try again.');}
    finally {if (current===generation.current) setBusy(false);}
  }
  async function loadRates(category:Category,after:string|null=null) {
    const current=++generation.current; setBusy(true); setMessage(''); setSelected(category); setRates(null);
    try {
      const path=`/api/v1/admin/catalog/categories/${encodeURIComponent(category.id)}/rates`+(after ? `?after=${encodeURIComponent(after)}` : '');
      const response=await fetch(path,{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if (current!==generation.current) return;
      if (response.status===401 || response.status===403) {setCategories(null);setSelected(null);setMessage('Admin access is required to view the catalog.');return;}
      if (!response.ok) throw Error('Unavailable');
      const data=page<Rate>(await response.json(),'rates');
      if (current===generation.current) setRates(data);
    } catch {if (current===generation.current) setMessage('Rates could not be loaded. Please try again.');}
    finally {if (current===generation.current) setBusy(false);}
  }
  return <section className="customer-profile catalog-viewer">
    <h2>Test catalog inspection</h2>
    <p>Development only, read-only. Admin permission is checked on every request. Pickup estimates use these categories and rates: a request takes the newest rate already in force at that moment.</p>
    <p>Pages are ordered by ID, not by date or name; concurrent changes may be missed. Restart to inspect from the beginning.</p>
    <button type="button" disabled={busy || disabled} onClick={()=>loadCategories()}>Load test catalog</button>
    <p role="status" aria-live="polite">{message}</p>
    {categories && <div>{categories.items.length===0 ? <p>No categories on this page.</p> : <ul>{categories.items.map(category=><li key={category.id}><strong>{category.name}</strong> — {category.active ? 'active':'inactive'} <button type="button" disabled={busy || disabled} onClick={()=>{ navigator.clipboard?.writeText(category.id).then(()=>setMessage('Category ID copied. Paste it into the pickup form.'),()=>{}); }}>Copy category ID</button> <button type="button" disabled={busy || disabled} onClick={()=>loadRates(category)}>View rates for {category.name}</button><br /><small className="category-id">{category.id}</small></li>)}</ul>}
      {categories.nextAfter && <button type="button" disabled={busy || disabled} onClick={()=>loadCategories(categories.nextAfter)}>Next categories</button>}</div>}
    {selected && rates && <div><h3>Rates for {selected.name}</h3>{rates.items.length===0 ? <p>No rates on this page.</p> : <ul>{rates.items.map(rate=>{
        // A rate created through the admin form must start in the future, so a
        // new rate is not in force yet. Say which it is instead of leaving the
        // reader to compare timestamps themselves.
        const start = Date.parse(rate.effectiveFrom);
        const inForce = Number.isFinite(start) && start <= Date.now();
        return <li key={rate.id}>₹{(rate.paisePerKg/100).toFixed(2)} per kg — effective {rate.effectiveFrom} UTC — <strong>{inForce ? 'in force' : 'not yet in force'}</strong>{inForce ? '' : '; pickup requests will be rejected with NO_RATE for this category until then'}</li>;
      })}</ul>}
      {rates.nextAfter && <button type="button" disabled={busy || disabled} onClick={()=>loadRates(selected,rates.nextAfter)}>Next rates</button>}</div>}
    <CatalogAdmin categoryId={selected && rates ? selected.id : null} disabled={disabled} />
  </section>;
}
