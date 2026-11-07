import { describe, expect, it } from 'vitest';
import { stringReverser } from './service';

// stringReverser(input, multiLine, emptyItems, trim, reverseWords): the fifth
// argument is loosely typed here so the project still compiles before it exists.
const reverse = stringReverser as (...args: unknown[]) => string;

describe('OMNI-1 reverse word order', () => {
  it('[OMNI-1][AC-1] reverses the order of words and keeps each word', () => {
    expect(reverse('Hello big world', false, false, false, true)).toBe(
      'world big Hello'
    );
  });

  it('[OMNI-1][AC-1] reverses word order of a longer single line', () => {
    expect(reverse('one two three four five', false, false, false, true)).toBe(
      'five four three two one'
    );
  });

  it('[OMNI-1][AC-2] reverses words of each line separately, keeping line order', () => {
    expect(reverse('one two\nthree four', true, false, false, true)).toBe(
      'two one\nfour three'
    );
  });

  it('[OMNI-1][AC-2] handles three lines of different word counts', () => {
    expect(reverse('a b c\nd e\nf', true, false, false, true)).toBe(
      'c b a\ne d\nf'
    );
  });

  it('[OMNI-1][AC-3] still reverses characters when the option is false', () => {
    expect(reverse('Hello World', false, false, false, false)).toBe(
      'dlroW olleH'
    );
    // the option is what switches between the two behaviours
    expect(reverse('Hello World', false, false, false, true)).toBe(
      'World Hello'
    );
  });

  it('[OMNI-1][AC-3] reverses characters when the argument is left out', () => {
    expect(reverse('Hello World', false, false, false)).toBe('dlroW olleH');
  });
});
