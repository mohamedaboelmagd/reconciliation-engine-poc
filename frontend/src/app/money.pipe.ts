import { Pipe, PipeTransform } from '@angular/core';

export function formatMoney(minor: number, currency: string): string {
  const v = (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${v}`;
}

@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(minor: number | null | undefined, currency: string): string {
    return minor == null ? '' : formatMoney(minor, currency);
  }
}
