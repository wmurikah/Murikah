import { redirect } from "next/navigation";

export default function RegisterPage() {
  redirect("/login?signup=1&next=/chat");
}
