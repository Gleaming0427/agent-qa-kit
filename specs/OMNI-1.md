# OMNI-1 — Reverse the order of words

The "Reverse" text tool (`/string/reverse`) reverses the characters of the text. Users also want to reverse the order of the words, keeping each word as it is.

- AC-1: the tool's options include "Reverse word order", off at first. With it on, the words of the text come out in reverse order and each word keeps its letters: "Hello big world" becomes "world big Hello".
- AC-2: with "Reverse word order" and "Process multi-line text" both on, the words of each line are reversed separately and the lines keep their order: "one two" on the first line and "three four" on the second become "two one" and "four three".
- AC-3: with "Reverse word order" off, the tool still reverses the characters: "Hello World" becomes "dlroW olleH".

## Answers to the QA writer's questions, 7 November

- **How the unit tests reach the feature.** Through the tool's service, as the tool's existing unit tests do (`reverse.service.test.ts`); no unit test in this project renders a component, and rendering this one under Vitest crashes. The browser tests cover the option in the page.
- **The service's signature.** The option is a fifth argument: `stringReverser(input, multiLine, emptyItems, trim, reverseWords)`, which is `false` when it is left out.
