"""求解器适配层。

业务代码只能依赖 Solver 接口，不能直接导入 scipy.optimize。
"""

from app.solvers.factory import get_solver

__all__ = ["get_solver"]
