import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

const FormField = ({ label, error, required, children, hint, className = '' }) => {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label}
          {required && <span className="text-status-error ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="mt-1 text-small text-gray-400">{hint}</p>}
      {error && <p className="mt-1 text-small text-status-error">{error}</p>}
    </div>
  );
};

FormField.Input = ({ label, error, required, hint, className = '', type = 'text', ...props }) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const isPassword = type === 'password';
  const input = <input className={error ? 'input-error' : 'input'} type={isPassword && passwordVisible ? 'text' : type} {...props} />;

  return (
    <FormField label={label} error={error} required={required} hint={hint} className={className}>
      {isPassword ? (
        <div className="password-input-wrap">
          {input}
          <button
            type="button"
            className="password-input-toggle"
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            aria-pressed={passwordVisible}
            onClick={() => setPasswordVisible((visible) => !visible)}
          >
            {passwordVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      ) : input}
    </FormField>
  );
};

FormField.Select = ({ label, error, required, hint, options = [], placeholder, className = '', ...props }) => (
  <FormField label={label} error={error} required={required} hint={hint} className={className}>
    <select className={error ? 'input-error' : 'input'} {...props}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  </FormField>
);

FormField.Textarea = ({ label, error, required, hint, className = '', ...props }) => (
  <FormField label={label} error={error} required={required} hint={hint} className={className}>
    <textarea className={error ? 'input-error' : 'input'} {...props} />
  </FormField>
);

export default FormField;
