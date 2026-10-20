import React, { useState } from 'react';
import { Search, X, Filter, ChevronDown } from 'lucide-react';

const FilterBar = ({ filters = [], searchPlaceholder = 'Search...', onSearchChange, searchValue = '', children }) => {
  const [expanded, setExpanded] = useState(false);

  // filters must be an array of { key, label, value, onChange, options }.
  // The default only covers `undefined`, so guard against null/objects too.
  const filterList = Array.isArray(filters) ? filters : [];
  if (import.meta.env?.DEV && filters && !Array.isArray(filters)) {
    console.warn('FilterBar: `filters` must be an array of { key, label, value, onChange, options }.');
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search */}
        {onSearchChange && (
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              className="input pl-9 pr-8"
            />
            {searchValue && (
              <button type="button" onClick={() => onSearchChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                <X size={14} />
              </button>
            )}
          </div>
        )}

        {/* Desktop filters */}
        <div className="hidden md:flex items-center gap-2 flex-wrap">
          {filterList.map(filter => (
            <FilterSelect key={filter.key} {...filter} />
          ))}
        </div>

        {/* Mobile filter toggle */}
        {filterList.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="md:hidden btn-secondary btn-sm"
          >
            <Filter size={14} />
            Filters
            {filterList.some(f => f.value) && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-brand-orange-100 text-brand-orange-700 rounded-full">
                {filterList.filter(f => f.value).length}
              </span>
            )}
          </button>
        )}

        {children}
      </div>

      {/* Mobile expanded filters */}
      {expanded && (
        <div className="md:hidden flex flex-col gap-2 p-3 bg-gray-50 rounded-md animate-fade-in">
          {filterList.map(filter => (
            <FilterSelect key={filter.key} {...filter} fullWidth />
          ))}
        </div>
      )}
    </div>
  );
};

const FilterSelect = ({ label, value, onChange, options = [], fullWidth = false }) => {
  const optionList = Array.isArray(options) ? options : [];

  return (
    <div className={fullWidth ? 'w-full' : ''}>
      <select
        value={value || ''}
        onChange={(e) => onChange && onChange(e.target.value)}
        className={`input py-1.5 text-small ${!value ? 'text-gray-400' : 'text-gray-900'} ${fullWidth ? 'w-full' : 'w-auto min-w-[140px]'}`}
      >
        <option value="">{label}</option>
        {optionList.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
};

export default FilterBar;