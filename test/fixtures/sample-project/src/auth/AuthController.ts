import { AuthService } from './AuthService';

export class AuthController {
  constructor(private readonly service: AuthService) {}

  handleLogin(body: { email: string; password: string }) {
    const token = this.service.login(body.email, body.password);
    return token ? { token } : { error: 'unauthorized' };
  }
}
