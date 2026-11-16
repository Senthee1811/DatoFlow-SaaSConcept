'use client';

import type { LossReasonDto, StageDto } from '@datoflow/shared';
import { Button, Field, Input, Modal, Select } from '@datoflow/ui';
import { useState, type FormEvent } from 'react';

export interface CloseRequest {
  leadName: string;
  stage: StageDto;
  dealValue: number | null;
}

/**
 * Asks for what a closed lead needs (PIPE-03): a loss reason for Lost, a deal value for Won.
 * Resolves with the extra fields, or null when cancelled.
 */
export function CloseDialog({
  request,
  lossReasons,
  currency,
  onDone,
}: {
  request: CloseRequest | null;
  lossReasons: LossReasonDto[];
  currency: string;
  onDone: (extra: { lossReasonId?: string; dealValue?: number } | null) => void;
}) {
  const [reason, setReason] = useState('');
  const [value, setValue] = useState('');
  const lost = request?.stage.kind === 'LOST';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (lost) onDone({ lossReasonId: reason });
    else onDone({ dealValue: Number(value) });
    setReason('');
    setValue('');
  }

  return (
    <Modal
      open={request !== null}
      title={lost ? 'Why was it lost' : 'Mark as won'}
      onClose={() => onDone(null)}
    >
      {request ? (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <p>
            {request.leadName} moves to{' '}
            <strong className="font-medium">{request.stage.name}</strong>.
          </p>
          {lost ? (
            <Field label="Loss reason">
              <Select required value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="" disabled>
                  Choose a reason
                </option>
                {lossReasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={`Deal value (${currency})`}>
              <Input
                type="number"
                inputMode="decimal"
                min={1}
                step="0.01"
                required
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button type="submit">{lost ? 'Mark as lost' : 'Mark as won'}</Button>
            <Button type="button" variant="ghost" onClick={() => onDone(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

/** Whether moving a lead into `stage` needs the dialog first. */
export function needsCloseDialog(
  stage: StageDto,
  dealValue: number | null,
  wonRequiresDealValue: boolean,
) {
  if (stage.kind === 'LOST') return true;
  return stage.kind === 'WON' && wonRequiresDealValue && !(dealValue && dealValue > 0);
}
