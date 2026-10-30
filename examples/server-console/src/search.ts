export type Service = { id: string; name: string; region: string };

export const SERVICES: Service[] = [
  { id: 'srv-1', name: 'Alpha', region: 'EU-1' },
  { id: 'srv-2', name: 'Beta', region: 'EU-2' },
  { id: 'srv-3', name: 'Gamma', region: 'US-1' },
];

// Correct implementation: case-insensitive matching.
export function filterServices(items: Service[], query: string): Service[] {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((service) => service.name.toLocaleLowerCase().includes(normalized));
}

// Intentional bug to demonstrate independently detecting a regression.
export function filterServicesBuggy(items: Service[], query: string): Service[] {
  return items.filter((service) => service.name.includes(query.trim()));
}
