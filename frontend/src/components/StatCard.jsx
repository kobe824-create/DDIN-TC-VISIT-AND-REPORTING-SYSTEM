import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const StatCard = ({ title, value, icon: Icon, trend, trendLabel, className = '' }) => {
  const trendColor = trend > 0 ? 'text-status-success' : trend < 0 ? 'text-status-error' : 'text-gray-400';
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;

  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium text-gray-500 truncate">{title}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{value}</p>
          {(trend !== undefined || trendLabel) && (
            <div className={`flex items-center gap-1 mt-1.5 ${trendColor}`}>
              <TrendIcon size={14} />
              <span className="text-small font-medium">
                {trend !== undefined && `${trend > 0 ? '+' : ''}${trend}%`}
                {trendLabel && <span className="text-gray-400 ml-1">{trendLabel}</span>}
              </span>
            </div>
          )}
        </div>
        {Icon && (
          <div className="flex-shrink-0 p-2.5 rounded-lg bg-brand-navy-50 text-brand-navy-700">
            <Icon size={20} />
          </div>
        )}
      </div>
    </div>
  );
};

export default StatCard;
