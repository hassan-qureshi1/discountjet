import { useState } from 'react';
import { InlineStack, Tag, TextField } from '@shopify/polaris';

/**
 * A multi-email input: type an address and press Enter (or comma) to add it as
 * a removable chip inside the field. Mirrors a "CC emails" style token input.
 */
export function EmailTagField({
  label,
  helpText,
  value,
  onChange,
}: {
  label: string;
  helpText?: string;
  value: string[];
  onChange: (emails: string[]) => void;
}) {
  const [input, setInput] = useState('');

  const commit = () => {
    const email = input.trim().replace(/,+$/, '').trim();
    if (email && /.+@.+\..+/.test(email) && !value.includes(email)) {
      onChange([...value, email]);
    }
    setInput('');
  };
  const remove = (email: string) => onChange(value.filter((e) => e !== email));

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commit();
        }
      }}
    >
      <TextField
        label={label}
        type="email"
        value={input}
        onChange={setInput}
        onBlur={commit}
        autoComplete="off"
        placeholder="Enter email and press Enter"
        helpText={helpText}
        verticalContent={
          value.length > 0 ? (
            <InlineStack gap="100">
              {value.map((email) => (
                <Tag key={email} onRemove={() => remove(email)}>
                  {email}
                </Tag>
              ))}
            </InlineStack>
          ) : undefined
        }
      />
    </div>
  );
}
