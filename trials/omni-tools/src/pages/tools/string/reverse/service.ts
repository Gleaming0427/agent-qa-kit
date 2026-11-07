import { reverseString } from 'utils/string';

export function stringReverser(
  input: string,
  multiLine: boolean,
  emptyItems: boolean,
  trim: boolean,
  reverseWords = false
) {
  let array: string[] = [];
  let result: string[] = [];

  // split the input in multiLine mode
  if (multiLine) {
    array = input.split('\n');
  } else {
    array.push(input);
  }

  // handle empty items
  if (emptyItems) {
    array = array.filter(Boolean);
  }
  // Handle trim
  if (trim) {
    array = array.map((line) => line.trim());
  }

  // Reverse the order of the words, each word kept as it is, or the characters
  result = array.map((element) =>
    reverseWords
      ? element.split(' ').reverse().join(' ')
      : reverseString(element)
  );
  return result.join('\n');
}
