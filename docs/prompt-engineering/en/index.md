---
layout: default
title: Prompt Engineering/Techniques
permalink: /prompt-engineering/en/
---

*[Türkçe](../)*

# Prompt Engineering and Techniques

**Prompt engineering** is the effective process of instruction. Writing that help us to get accurate, consistent outcomes we want from an AI model.

Since AI models are *non-deterministic*, asking the same question in two different ways can produce two answers of very different quality. In this section, we'll go over a few techniques for getting good, consistent results.

## Table of Contents

1. [Standard Prompt](#standard-prompt)
2. [Zero-Shot Prompting](#zero-shot)
3. [One-Shot Prompting](#one-shot)
4. [Few-Shot Prompting](#few-shot)
5. [Structured Output](#structured-output)
6. [Chain of Thought](#chain-of-thought)
7. [Delimiters / XML Tags](#delimiters-xml)
8. [Persona](#persona)
9. [Summary Comparison Table](#summary-table)

---

## 1. Standard Prompt (Plain Prompt) {#standard-prompt}

The technique we all use when we are talking to an LLM. Most probably you use that at least once a day if you are dealing with AI daily. Standard prompts are usually the short, plain instructions we give an AI assistant.

Every other technique here is really just a tool for fixing ambiguity, inconsistenty, formatting and unpredictable quality. There is nothing wrong with standard prompts, those are techniques we apply to get desired output depending on cases.

**Example — Product Owner:**

Let's take the "add product to cart" feature on an e-commerce site.

```
Write a user story for the "add to cart" feature on our ACME e-commerce site.
```

**Format**

- Which user type (a registered customer or a guest)?
- Which format ("As a... I want... So that..." or a bulleted list)?
- Are acceptance criteria expected?
- Should the likely business value be mentioned?

A standard prompt can be enough for a quick draft, but it's usually not enough for a usable, repeatable result.

---

## 2. Zero-Shot Prompting {#zero-shot}

Zero-shot prompting is kind of our baseline. Every zero-shot prompt could be called a standard prompt, but not every standard prompt is a zero-shot prompt.

When the task is simple or about something the model already knows well. For the case, if we don't need to provide an example zero-shot will be enough.

**Example — Business Analyst:**

```
Prepare a business requirements document for the "return process" on an e-commerce platform. Write a list of requirements based on the following information:

- A customer must be able to request a return within 14 days of purchase.
- The product must be unused and in its original packaging.
- Once a return is approved, the refund must be issued to the customer within 5 business days.
```

---

## 3. One-Shot Prompting {#one-shot}

After describing the goal to the model, you give it **a single example** that shows exactly the format or style you want. The model uses that example as a reference for producing its own output.

Used when format or style matters for the task isn't to complex and a single example is enough.

**Example — QA Engineer/Tester:**

```
Write a test case in the format below. Review the example, then write a
new test case in the same format for the "pay with coupon code" feature.

Example:
Test ID: TC-101
Title: Payment with an invalid credit card number
Precondition: The user has added a product to the cart and is on the payment screen.
Steps:
  1. Enter an invalid credit card number.
  2. Click "Complete Payment."
Expected Result: The system shows an "Invalid card number" error message
and does not process the payment.

New scenario topic: Attempting to pay with an expired coupon code.
```

---

## 4. Few-Shot Prompting {#few-shot}

A step beyond one-shot: you give the model **multiple examples (usually 2-5)** to teach it both the format and the **pattern/logic** across the examples. As the number of examples grows, the model captures the desired pattern more reliably. Especially when the examples contains diversity (e.g. different scenarios, edge cases), few-shot can give more consistent results than one-shot.

Few-shot is preferred when the goal contains more variety than a single example could fully capture (different situations, different tone/style variations).

**Example — Developer:**

A developer wants code review comments written in the team's standard style:

```
Below are some example code review comments. Write a new review comment
matching the style in these examples (polite, justified, with a concrete
suggestion).

Example 1:
Code: for(let i=0; i<items.length; i++) { total += items[i].price }
Comment: Using `reduce` here would make the code more readable:
`const total = items.reduce((sum, item) => sum + item.price, 0);`
The performance difference is negligible, but I'd recommend it for readability.

Example 2:
Code: if(user.role == ROLE.ADMIN) { ... }
Comment: I'd recommend using `===` instead of `==`; this avoids unexpected
bugs caused by type coercion in JavaScript.

New review:
Code: function getDiscount(price) { return price - (price * 0.1) }
```

The two examples show the model both the **tone** of the comment and its **structure** (point out the issue → give a concrete code suggestion → add a brief justification).

---

## 5. Structured Output {#structured-output}

Instead of free-form text, you ask the model for output in **a specific format** (JSON, a table, YAML, a Markdown list, etc.). This matters a lot when the output needs to be processed automatically in a later step eg. fed into a system, or into a dashboard.

**Example — Delivery Manager:**

```
Return the following sprint status information as valid JSON, ready to
feed into a dashboard.

Information:
- Sprint 14, e-commerce "Checkout" team
- Planned 32 story points, completed 27 story points
- 3 open bugs, 1 of critical priority (critical bug: payment page crashes on mobile)
- Sprint end date: 2026-09-19

Requested JSON schema:
{
  "sprint": number,
  "team": string,
  "plannedPoints": number,
  "completedPoints": number,
  "openBugs": number,
  "criticalBugs": [string],
  "sprintEndDate": string
}
```

---

## 6. Chain of Thought {#chain-of-thought}

Instead of asking the model to jump straight to a final answer, you ask it to reason **step by step** ("let's think step by step") on its way to a conclusion. Nowadays most of models have reasoning however instructions like "think step by step" or "first list the options, then compare them, then decide" still effective and they are part of this technique.

**Example — Solution Architect:**

```
We're redesigning the "inventory check" service on our e-commerce platform.
We need to decide between two options:

Option A: Improve the inventory module inside the existing monolithic application.
Option B: Extract inventory checking into a separate microservice.

Context:
- We process an average of 50,000 orders per day, rising to 300,000 during campaigns.
- The team has 6 people with limited microservices operations experience.
- Inventory data must sync frequently with the order and payment services.

Think step by step:
1. First list the scalability pros/cons of each option.
2. Then evaluate them in terms of team capability and operational risk.
3. Then evaluate them in terms of data consistency.
4. Finally, combine these three evaluations into a well-reasoned recommendation.
```

If we had simply asked the model "A or B?", we would likely get a shallow, one-dimensional answer. Asking it to think step by step instead makes the model evaluate each criterion separately and arrive at a more balanced, well-reasoned conclusion. The visible reasoning steps in the output can also make the decision easier for us to review.

---

## 7. Delimiters / XML Tags {#delimiters-xml}

In a long or multi-part prompt, delimiters like `"""` or `---`, or XML-like tags such as `<context>...</context>` and `<data>...</data>`, are used to separate different sections (context, instructions, data, examples) from one another. This keeps the model from getting confused about "is this part an instruction, or is it data to be processed?"

When a prompt contains more than one block of information, eg. both instructions and raw text to work on, using delimiters/XML can help to reduce confusion, especially in long prompts. Claude is particularly good at distinguishing XML tags, which is why this technique is frequently recommended when working with Claude yet it doesn't mean that it won't work for other providers. You can run experiments depending on your cases to see if its help. XML is not the only delimeters you could use for any LLM.

**Example — Product Owner:**

```
Below is raw customer feedback inside a <feedback> tag, and our
product constraints inside a <constraints> tag.

<feedback>
"My cart empties out whenever I refresh the page after adding an item.
This is especially annoying when shopping on mobile — I keep having to
add the same items again and again."
</feedback>

<constraints>
- Cart data is currently only stored in browser local storage.
- The cart must persist for guest (not logged in) users too.
- The fix must be deliverable within one sprint.
</constraints>

Using the <feedback> and <constraints> information above, write a user
story in "As a... I want... So that..." format for the development team,
along with a 3-item acceptance criteria list.
```

The `<feedback>` and `<constraints>` tags let the model clearly tell apart which text is "raw data to process" and which is "a constraint to respect."

---

## 8. Persona {#persona}

You tell the model to **take on a specific area of expertise** while producing its answer ("You are a senior security engineer..."). This steers the **perspective, prioritization, and terminology** in the model's answer toward that role's area of expertise.

Assigning a persona doesn't give the model some new, unreal capability. The model itself filters the knowledge it already has through the lens of the requested role. In other words, a persona shapes "what the model focuses on" and "in what tone it speaks". It isn't a magic source of expertise.

Used when you want an evaluation, risk analysis, or feedback from a specific expert perspective, or when the output needs to be in a tone suited to a specific audience (e.g., executives/managers).

**Example**

```
You are a senior security test engineer specialized in e-commerce payment
systems. You have deep experience detecting security vulnerabilities
(especially the OWASP Top 10).

Review the "coupon code validation" flow described below through that
lens, and list the possible security risks — each with a brief
explanation and a recommended mitigation:

"The user enters a coupon code on the payment screen. The system looks
the code up directly in the database, and if it's found, applies the
discount. The same user can try as many times as they want — there's
no attempt limit."
```

---

## 9. Summary Comparison Table {#summary-table}

| Technique | When to use | Main benefit |
|---|---|---|
| Standard Prompt | Quick, one-off, draft-level tasks | Speed |
| Zero-Shot | Task is simple, model already knows the topic | Low effort, a clear instruction is enough |
| One-Shot | A specific format/style needs to be imitated | Format consistency |
| Few-Shot | Format + a complex pattern/variety needs to be taught | High consistency |
| Structured Output | Output will be processed by a system/code | Automatic processability |
| Chain of Thought | Multi-step decisions or complex problem solving | More accurate, well-reasoned result |
| Delimiters / XML | The prompt contains multiple blocks of information | Prevents confusion, adds clarity |
| Persona | A specific expert perspective is needed | Focused, audience-appropriate tone |

> **Note:** These techniques aren't alternatives to one another — they're often used **together**. For example, a common real-world prompt assigns a **persona**, separates context with **XML tags**, provides **few-shot** examples, asks the model to reason with **chain of thought**, and finally requests the answer in a **structured output** format.
