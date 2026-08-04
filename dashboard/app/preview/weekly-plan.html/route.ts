import { redirect } from "next/navigation";

export async function GET() {
  redirect("/?view=weekly");
}
