import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function ListPagination({ page, pages, total, pageSize, onPageChange, onPageSizeChange }) {
  const pageCount = Math.max(pages || 0, 1);
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);

  return <div className="list-pagination">
    <span className="list-pagination-range">Showing {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}</span>
    <div className="list-pagination-controls">
      <label className="list-page-size"><span>Rows</span><select className="input" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} aria-label="Rows per page">
        <option value={10}>10</option><option value={25}>25</option><option value={50}>50</option>
      </select></label>
      <span className="list-page-count">Page {page} of {pageCount.toLocaleString()}</span>
      <button className="list-page-button" type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={17} /></button>
      <button className="list-page-button" type="button" onClick={() => onPageChange(Math.min(pageCount, page + 1))} disabled={page >= pageCount} aria-label="Next page"><ChevronRight size={17} /></button>
    </div>
  </div>;
}
