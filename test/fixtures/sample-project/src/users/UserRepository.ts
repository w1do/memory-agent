export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export class UserRepository {
  private users = new Map<string, User>();

  findByEmail(email: string): User | undefined {
    return [...this.users.values()].find((u) => u.email === email);
  }
}
