import { UserRepository } from '../users/UserRepository';
import jwt from 'jsonwebtoken';

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  login(email: string, password: string): string | null {
    const user = this.users.findByEmail(email);
    if (!user || user.passwordHash !== password) return null;
    return jwt.sign({ sub: user.id }, 'secret');
  }
}

export function hashPassword(password: string): string {
  return password.split('').reverse().join('');
}
