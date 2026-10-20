import React, { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

const DataTable = ({
  columns,
  data = [],
  onRowClick,
  pageSize: initialPageSize = 20,
  sortable = true,
  emptyMessage = 'No data available',
  emptyIcon: EmptyIcon,
  loading = false,
  mobileCardRender,
  className = '',
}) => {
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(0);
  const pageSize = initialPageSize;

  // data can be null/undefined/non-array while loading or on error
  const rows = Array.isArray(data) ? data : [];

  const sortedData = useMemo(() => {
    if (!sortField) return rows;
    const col = columns.find(c => c.key === sortField);
    const getVal = (row) => (col?.sortValue ? col.sortValue(row) : row[sortField]);
    return [...rows].sort((a, b) => {
      const aVal = getVal(a);
      const bVal = getVal(b);
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp =
        typeof aVal === 'string' || typeof bVal === 'string'
          ? String(aVal).localeCompare(String(bVal), undefined, { numeric: true })
          : aVal - bVal;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, columns, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedData = sortedData.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const handleSort = (field) => {
    if (!sortable) return;
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setPage(0);
  };

  if (loading) {
    return (
      <div className={`card overflow-hidden ${className}`}>
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-4 py-3 flex gap-4 animate-pulse">
              {columns.map((col, j) => (
                <div key={j} className="flex-1">
                  <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={`card p-8 text-center ${className}`}>
        {EmptyIcon && <EmptyIcon size={40} className="mx-auto text-gray-300 mb-3" />}
        <p className="text-sm text-gray-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={`card overflow-hidden ${className}`}>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              {columns.map(col => (
                <th
                  key={col.key}
                  className={`table-header ${col.width || ''} ${sortable && col.sortable !== false ? 'cursor-pointer select-none hover:text-gray-700' : ''}`}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    {sortField === col.key && (
                      sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pagedData.map((row, i) => (
              <tr
                key={row.id ?? i}
                className={onRowClick ? 'table-row-clickable' : 'table-row'}
                onClick={() => onRowClick && onRowClick(row)}
              >
                {columns.map(col => (
                  <td key={col.key} className="table-cell">
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-gray-100">
        {pagedData.map((row, i) => (
          <div
            key={row.id ?? i}
            className={`p-4 ${onRowClick ? 'cursor-pointer hover:bg-gray-50 active:bg-gray-100' : ''}`}
            onClick={() => onRowClick && onRowClick(row)}
          >
            {mobileCardRender ? mobileCardRender(row) : (
              <div className="space-y-1">
                {columns.slice(0, 3).map(col => (
                  <div key={col.key} className="flex items-center justify-between">
                    <span className="text-small text-gray-500">{col.label}</span>
                    <span className="text-sm text-gray-900">
                      {col.render ? col.render(row[col.key], row) : row[col.key]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
          <div className="text-small text-gray-500">
            {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sortedData.length)} of {sortedData.length}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="First page" onClick={() => setPage(0)} disabled={safePage === 0} className="btn-ghost btn-sm p-1 disabled:opacity-30">
              <ChevronsLeft size={16} />
            </button>
            <button type="button" aria-label="Previous page" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} className="btn-ghost btn-sm p-1 disabled:opacity-30">
              <ChevronLeft size={16} />
            </button>
            <span className="text-small text-gray-600 px-2">{safePage + 1} / {totalPages}</span>
            <button type="button" aria-label="Next page" onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1} className="btn-ghost btn-sm p-1 disabled:opacity-30">
              <ChevronRight size={16} />
            </button>
            <button type="button" aria-label="Last page" onClick={() => setPage(totalPages - 1)} disabled={safePage >= totalPages - 1} className="btn-ghost btn-sm p-1 disabled:opacity-30">
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataTable;