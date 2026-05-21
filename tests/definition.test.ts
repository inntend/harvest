import { describe, expect, it } from 'vitest';
import { SchemaError } from '../src/definition';

describe('SchemaError', () => {
  it('is an instance of both Error and SchemaError', () => {
    const err = new SchemaError('something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SchemaError);
    expect(err.message).toBe('something went wrong');
  });

  it('can be thrown and caught as an Error', () => {
    expect(() => {
      throw new SchemaError('bad schema');
    }).toThrow(Error);
  });
});
