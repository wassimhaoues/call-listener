import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import Button from "../src/components/ui/Button.jsx";

it("renders its label, visual variant, and click behavior", () => {
  const onClick = vi.fn();

  render(
    <Button variant="danger" onClick={onClick}>
      Stop interview
    </Button>
  );

  const button = screen.getByRole("button", { name: "Stop interview" });
  expect(button).toHaveClass("btn", "btn-danger");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
