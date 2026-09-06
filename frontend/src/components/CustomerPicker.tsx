import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../lib/api';
import type { Customer } from '../lib/types';

interface Props {
  name: string;
  phone: string;
  onChange: (next: { name: string; phone: string }) => void;
}

/**
 * Name and phone with lookup over existing customers.
 *
 * The owner types, not selects: regulars surface as suggestions but a brand new
 * walk-in never has to be created as a separate step first.
 */
export function CustomerPicker({ name, phone, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const { data: matches = [] } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => get<Customer[]>(`/customers?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2,
  });

  function search(value: string) {
    setQuery(value);
    setOpen(true);
  }

  return (
    <>
      <div className="field">
        <label htmlFor="cust-name">Customer name</label>
        <input
          id="cust-name"
          value={name}
          placeholder="Leave blank for a walk-in"
          onChange={(e) => {
            onChange({ name: e.target.value, phone });
            search(e.target.value);
          }}
          onFocus={() => name.length >= 2 && search(name)}
          autoComplete="off"
        />
      </div>

      <div className="field">
        <label htmlFor="cust-phone">Phone</label>
        <input
          id="cust-phone"
          value={phone}
          placeholder="+91 98450 00000"
          inputMode="tel"
          onChange={(e) => {
            onChange({ name, phone: e.target.value });
            search(e.target.value);
          }}
          autoComplete="off"
        />

        {open && matches.length > 0 && (
          <div className="suggestions">
            {matches.slice(0, 6).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange({ name: c.name, phone: c.phone });
                  setOpen(false);
                }}
              >
                <strong>{c.name}</strong> <span className="faint mono">{c.phone}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
