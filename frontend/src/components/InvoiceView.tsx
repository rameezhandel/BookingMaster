import { DateTime } from 'luxon';
import { rupees } from '../lib/format';
import type { Invoice } from '../lib/types';

/**
 * The document itself, laid out to be printed or saved as a PDF from the
 * browser's own print dialog.
 *
 * Everything shown comes from the invoice row rather than from the venue or the
 * customer as they are now. That is the point of the snapshot: a document
 * already handed to someone does not change when the venue moves premises.
 */
export function InvoiceView({ invoice }: { invoice: Invoice }) {
  const isCreditNote = invoice.kind === 'credit_note';
  const tax = invoice.cgstPaise + invoice.sgstPaise + invoice.igstPaise;
  const ratePct = invoice.gstRateBp / 100;

  return (
    <div className="invoice-doc">
      <div className="invoice-head">
        <div>
          <div className="invoice-title">{isCreditNote ? 'Credit Note' : 'Tax Invoice'}</div>
          <div className="invoice-number mono">{invoice.number}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>
            Issued
          </div>
          <div>{DateTime.fromISO(invoice.issuedAt).toFormat('d LLLL yyyy')}</div>
        </div>
      </div>

      <div className="invoice-parties">
        <div>
          <div className="faint invoice-label">From</div>
          <div style={{ fontWeight: 650 }}>{invoice.supplierName}</div>
          {invoice.supplierAddress && <div className="muted">{invoice.supplierAddress}</div>}
          {invoice.supplierGstin && (
            <div className="mono" style={{ fontSize: 12 }}>
              GSTIN {invoice.supplierGstin}
            </div>
          )}
        </div>
        <div>
          <div className="faint invoice-label">To</div>
          <div style={{ fontWeight: 650 }}>{invoice.customerName ?? 'Walk-in'}</div>
          {invoice.customerPhone && <div className="muted mono">{invoice.customerPhone}</div>}
          {invoice.customerGstin && (
            <div className="mono" style={{ fontSize: 12 }}>
              GSTIN {invoice.customerGstin}
            </div>
          )}
          {invoice.placeOfSupply && (
            <div className="faint" style={{ fontSize: 12 }}>
              Place of supply: {invoice.placeOfSupply}
            </div>
          )}
        </div>
      </div>

      <table className="invoice-lines">
        <thead>
          <tr>
            <th>Description</th>
            {invoice.sacCode && <th>SAC</th>}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{invoice.description}</td>
            {invoice.sacCode && <td className="mono">{invoice.sacCode}</td>}
            <td className="num mono">{rupees(invoice.taxablePaise)}</td>
          </tr>
        </tbody>
      </table>

      <div className="invoice-totals">
        <div className="row">
          <span>Taxable value</span>
          <span className="mono">{rupees(invoice.taxablePaise)}</span>
        </div>
        {invoice.igstPaise > 0 ? (
          <div className="row">
            <span>IGST @ {ratePct}%</span>
            <span className="mono">{rupees(invoice.igstPaise)}</span>
          </div>
        ) : (
          <>
            <div className="row">
              <span>CGST @ {ratePct / 2}%</span>
              <span className="mono">{rupees(invoice.cgstPaise)}</span>
            </div>
            <div className="row">
              <span>SGST @ {ratePct / 2}%</span>
              <span className="mono">{rupees(invoice.sgstPaise)}</span>
            </div>
          </>
        )}
        <div className="row total">
          <span>{isCreditNote ? 'Credited' : 'Total'}</span>
          <span className="mono">{rupees(invoice.totalPaise)}</span>
        </div>
      </div>

      {tax === 0 && (
        <p className="faint" style={{ fontSize: 12 }}>
          No tax charged on this supply.
        </p>
      )}

      <div className="invoice-foot faint">
        {isCreditNote
          ? 'This credit note reverses the invoice named in the description above.'
          : 'This is a computer-generated invoice.'}
      </div>
    </div>
  );
}
